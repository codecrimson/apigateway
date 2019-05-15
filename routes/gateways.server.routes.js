/**
 * Module dependencies
 */
const gatewaysPolicy = require('../policies/gateways.server.policy');
const gateways = require('../controllers/gateways.server.controller');

// eslint-disable-next-line func-names
module.exports = function (app) {
  // Gateways collection routes
  app.route('/api/gateways/tickets*').all(gatewaysPolicy.isAllowed)
    .get(gateways.processTickets)
    .post(gateways.processTickets)
    .put(gateways.processTickets)
    .delete(gateways.processTickets);
};
