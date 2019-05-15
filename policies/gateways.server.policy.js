/* eslint-disable func-names */
/**
 * Module dependencies
 */
let acl = require('acl');

// Using the memory backend
acl = new acl(new acl.memoryBackend()); // eslint-disable-line new-cap

/**
 * Invoke Gateways Permissions
 */
exports.invokeRolesPolicies = function () {
  acl.allow([{
    roles: ['admin'],
    allows: [{
      resources: '/api/gateways/tickets*',
      permissions: '*',
    }],
  }, {
    roles: ['user'],
    allows: [{
      resources: '/api/gateways/tickets*',
      permissions: '*',
    }],
  }, {
    roles: ['guest'],
    allows: [{
      resources: '/api/gateways',
      permissions: ['get'],
    }, {
      resources: '/api/gateways/:gatewayId',
      permissions: ['get'],
    }],
  }]);
};

/**
 * Check If Gateways Policy Allows
 */
exports.isAllowed = function (req, res, next) { // eslint-disable-line consistent-return
  const roles = (req.user) ? req.user.roles : ['guest'];

  // If an gateway is being processed and the current user created it then allow any manipulation
  if (req.gateway && req.user && req.gateway.user && req.gateway.user.id === req.user.id) {
    return next();
  }

  // Check for user roles
  acl.areAnyRolesAllowed(roles, req.route.path, req.method.toLowerCase(), (err, isAllowed) => {
    if (err) {
      // An authorization error occurred
      return res.status(500).send('Unexpected authorization error');
    }
    if (isAllowed) {
        // Access granted! Invoke next middleware
      return next();
    }
    return res.status(403).json({
      message: 'User is not authorized',
    });
  });
};
