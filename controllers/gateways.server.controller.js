/* eslint-disable no-underscore-dangle,consistent-return,func-names,no-param-reassign */
/**
 * Module dependencies
 */
const path = require('path');
const config = require(path.resolve('./server/config/config'));
const gatewayPath = '/api/gateways/';
const request = require('request');
const errorHandler = require(path.resolve('./server/modules/core/controllers/errors.server.controller'));
const mongoose = require('mongoose');
const User = mongoose.model('User');
const async = require('async');
const ticketsSlackWebHook = require(path.resolve('./server/utils/slackWebhooks')).ticketsChannel;
const userUtils = require(path.resolve('./server/utils/userUtils'));
const Mustache = require('mustache');
const fs = require('fs');
const nodemailer = require('nodemailer');
const smtpTransport = nodemailer.createTransport(config.mailer.options);

const populateList = {};
populateList.user = { model: User, select: '-salt -password' };
populateList.to = { model: User, select: '-salt -password' };
populateList.from = { model: User, select: '-salt -password' };
populateList.responder = { model: User, select: '-salt -password' };


const ticketServer = `${'http://localhost'}:${config.ticketAPI.port}`;
// const excludeApiFromEmails = ['/^/api/tickets/[a-f\d]{24}$/i'];

function excludeApiFromEmails(reqPath) {
  return [
    /api\/tickets\/[a-f\d]{24}$/i,
  ].some((regexp) => regexp.test(reqPath));
}

/* Process requests to ticket api */
exports.processTickets = function (req, res) {
  const ticketAPI = (req.url.split(gatewayPath))[1];
  const ticketRequest = `${ticketServer}/api/${ticketAPI}`;

  const options = { json: true, headers: req.headers, method: req.method, gzip: true };
  if (req.method === 'POST' || req.method === 'PUT') {
    options.headers['content-length'] = req.body.length;
    options.body = req.body;
  }

  let populateRequest = [];

  request(ticketRequest, options, (err, ticketRes, body) => {
    if (err) {
      let ticketResponse = 502;
      if (ticketRes) {
        ticketResponse = ticketRes.statusCode;
      }
      return res.status(ticketResponse).send({
        message: JSON.stringify(err.errno),
      });
    }

    const searchCache = {};

    if (body) {
      if (body.constructor === Array) {
        for (let i = 0; i < body.length; i += 1) {
          const ticketData = body[i];
          const inspectedData = inspectForPopulate(ticketData, '');
          if (inspectedData) {
            populateRequest = inspectedData;
          }
        }
        async.eachSeries(populateRequest, (populate, callback) => { // loop through array
          const pathVal = populate.path.substr(1);
          async.eachSeries(body, (child, callback1) => { // loop through array
            const bodyIndex = body.findIndex((member) => member[pathVal] === child[pathVal]);
            const cacheObject = JSON.stringify({
              key: child[pathVal],
              model: populate.db.model.collection.collectionName,
            });
            const cacheReturn = searchCache[cacheObject];
            if (cacheReturn) {
              body[bodyIndex][pathVal] = cacheReturn;
              callback1();
            } else {
              populate.db.model.findById(child[pathVal]).select(populate.db.select).exec((findErr, found) => {
                body[bodyIndex][pathVal] = found;
                searchCache[cacheObject] = found;
                callback1();
              });
            }
          }, (asyncFinderr) => { // eslint-disable-line no-unused-vars
            callback();
          });
        }, (asyncErr) => {
          if (asyncErr) {
            return res.status(501).send({
              message: errorHandler.getErrorMessage(asyncErr),
            });
          }
          sendMessageToSlack(res, body, ticketRes);
          return postProcessTickets(req, res, body, ticketRes);
        });
      } else {
        const inspectedData = inspectForPopulate(body, '');
        if (inspectedData) {
          populateRequest = inspectedData;
        }
        async.eachSeries(populateRequest, (populate, callback) => { // loop through array
          const pathVal = populate.path.substr(1);
          const cacheObject = JSON.stringify({ key: body[pathVal], model: populate.db.model.collection.collectionName });
          const cacheReturn = searchCache[cacheObject];
          if (cacheReturn) {
            body[pathVal] = cacheReturn;
            callback();
          } else {
            populate.db.model.findById(body[pathVal]).select(populate.db.select).exec((findErr, found) => {
              body[pathVal] = found;
              searchCache[cacheObject] = found;
              callback();
            });
          }
        }, (asyncErr) => {
          if (asyncErr) {
            return res.status(501).send({
              message: errorHandler.getErrorMessage(asyncErr),
            });
          }
          sendMessageToSlack(res, body, ticketRes);
          return postProcessTickets(req, res, body, ticketRes);
        });
      }
    } else {
      return res.sendStatus(ticketRes.statusCode);
    }
  });
};

function sendMessageToSlack(res, body, ticketRes) {
  if (ticketRes && ticketRes.req) {
    if (ticketRes.req.method === 'POST' || ticketRes.req.method === 'PUT') {
      ticketsSlackWebHook(body, 'Ticket Updated').then(() => {
      }).catch((e) => console.log('slack error', e)); // post to slack
    }
  }
}


function postProcessTickets(req, res, body, ticketRes) {
  let sendToUSer;

  if (ticketRes && ticketRes.req && !excludeApiFromEmails(ticketRes.req.path)) {
    if (ticketRes.req.method === 'POST' || ticketRes.req.method === 'PUT') {
      const isTicketCreator = req.user._id.equals(body.from._id);
      if (isTicketCreator) {
        sendToUSer = body.responder ? body.responder : body.to;
      } else {
        sendToUSer = body.from;
      }
    }
  }

  async.waterfall([
    function (done) {
      if (ticketRes && ticketRes.req && sendToUSer) {
        if (ticketRes.req.method === 'POST' || ticketRes.req.method === 'PUT') {
          let httpTransport = 'http://';
          if (config.secure && config.secure.ssl === true) {
            httpTransport = 'https://';
          }
          const baseUrl = req.app.get('domain') || httpTransport + req.headers.host; // eslint-disable-line no-unused-vars
          const view = {
            name: sendToUSer.displayName,
            appName: config.app.title,
            browser_name: userUtils.getBrowserInfo(req).ua,
            domain_url: config.domain,
            user_ip: userUtils.getUserIP(req),
            action_url: `${baseUrl}/chat/${body._id}`,
            support_url: `${baseUrl}/support`,
            address: config.app.contactInfo.address,
            message: JSON.parse(ticketRes.request.body).message.message,
          };
          fs.readFile(path.resolve('./server/modules/gateways/templates/NewMessageEmail.html'), (err, emailHTML) => {
            const rendered = Mustache.render(emailHTML.toString(), view);
            done(err, rendered);
          });
        } else {
          const errorFlag = false;
          const sendEmail = false;
          done(errorFlag, sendEmail);
        }
      } else {
        const errorFlag = false;
        const sendEmail = false;
        done(errorFlag, sendEmail);
      }
    },
    function (emailHTML, done) {
      if (sendToUSer && emailHTML) {
        const mailOptions = {
          to: sendToUSer.email,
          from: config.mailer.from,
          subject: `${config.app.title} - New message`,
          html: emailHTML,
        };
        if (process.env.NODE_ENV === 'production') {
          smtpTransport.sendMail(mailOptions, (err) => {
            done(err);
          });
        } else {
          done();
        }
      } else {
        done();
      }
    },
    function (done) {
      res.status(ticketRes.statusCode).send(body);
      done();
    },
  ], (err) => {
    if (err) {
      return res.status(501).send({
        message: errorHandler.getErrorMessage(err),
      });
    }
  });
}

function inspectForPopulate(dataArray, currentPath) {
  const matched = [];
  Object.keys(dataArray).forEach((key) => {
    const updatedPath = `${currentPath}.${key}`;
    if (populateList[key]) {
      matched.push({ path: updatedPath, db: populateList[key] });
    }
    if (dataArray[key].constructor === Array) {
      const inspectedData = inspectForPopulate(dataArray[key], updatedPath);
      if (inspectedData) {
        matched.push(inspectForPopulate(dataArray[key], updatedPath));
      }
    }
  });
  if (matched.length === 0) {
    return undefined;
  }
  return matched;
}
