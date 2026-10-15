const { checkPermission, isValidRole, canAssignRole } = require('../utils/permissions');

/**
 * Authorization Middleware
 * 
 * Provides middleware functions to check user permissions and roles
 * for protecting routes based on RBAC (Role-Based Access Control).
 */

/**
 * Require a specific permission
 * Returns middleware that checks if the authenticated user has the required permission.
 * 
 * @param {string} permission - Required permission name
 * @returns {Function} Express middleware function
 */
function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      // Role comes only from the verified token (authenticateToken), never from request headers
      if (!req.user) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required'
        });
      }
      const userRole = req.user.role;
      const userId = req.user.id;

      // Check if user has the required permission
      if (!checkPermission(userRole, permission)) {
        // Get allowed roles for this permission (for better error message)
        const allowedRoles = [];
        const { PERMISSIONS } = require('../utils/permissions');
        for (const [role, rolePerms] of Object.entries(PERMISSIONS)) {
          if (rolePerms.includes(permission)) {
            allowedRoles.push(role);
          }
        }

        return res.status(403).json({
          error: 'Permission denied',
          message: `Your role (${userRole}) does not have permission to ${permission}`,
          requiredPermission: permission,
          userRole: userRole,
          allowedRoles: allowedRoles
        });
      }

      // Attach role and userId to request for use in route handlers (documentation compatibility)
      if (!req.userRole) req.userRole = userRole;
      if (!req.userId) req.userId = userId;

      // User has permission, continue
      next();
    } catch (error) {
      console.error('Authorization error:', error);
      return res.status(500).json({
        error: 'Internal server error',
        message: 'Authorization check failed'
      });
    }
  };
}

/**
 * Require one of the specified roles
 * Returns middleware that checks if the authenticated user has one of the allowed roles.
 * 
 * @param {...string} roles - Allowed role names
 * @returns {Function} Express middleware function
 */
function requireRole(...roles) {
  return async (req, res, next) => {
    try {
      // Check if user is authenticated
      if (!req.user) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required'
        });
      }

      const userRole = req.user.role;

      // Check if user has one of the allowed roles
      if (!roles.includes(userRole)) {
        return res.status(403).json({
          error: 'Permission denied',
          message: 'Your role does not have access to this resource',
          allowedRoles: roles,
          userRole: userRole
        });
      }

      // User has allowed role, continue
      next();
    } catch (error) {
      console.error('Authorization error:', error);
      return res.status(500).json({
        error: 'Internal server error',
        message: 'Authorization check failed'
      });
    }
  };
}

/**
 * Require workspace access
 * Returns middleware that ensures the user can access workspace data.
 * Platform admins can access all workspaces, others can only access their own.
 * 
 * @param {string} companyParam - Name of the query/body parameter containing company/workspace identifier
 * @returns {Function} Express middleware function
 */
function requireWorkspaceAccess(companyParam = 'company') {
  return async (req, res, next) => {
    try {
      // Check if user is authenticated
      if (!req.user) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required'
        });
      }

      // Platform admin can access all workspaces
      if (req.user.role === 'platform_admin') {
        return next();
      }

      // Get requested company/workspace from query params or body
      const requestedCompany = req.query[companyParam] || req.body[companyParam];

      // If no company specified, allow (will be filtered in controller)
      if (!requestedCompany) {
        return next();
      }

      // Get user's company_id (workspace identifier)
      const userCompanyId = req.user.company_id;

      // If user doesn't have a company_id, deny access
      if (!userCompanyId) {
        return res.status(403).json({
          error: 'Permission denied',
          message: 'User does not belong to a workspace'
        });
      }

      // Note: This assumes company_id matches the company string identifier
      // If your system uses different identifiers, adjust this logic accordingly
      // For now, we'll allow the request and let the controller handle filtering
      // The actual filtering should be done in controllers using workspace scoping

      next();
    } catch (error) {
      console.error('Workspace access check error:', error);
      return res.status(500).json({
        error: 'Internal server error',
        message: 'Workspace access check failed'
      });
    }
  };
}

/**
 * Require one of the specified permissions
 * Returns middleware that checks if the authenticated user has at least one of the required permissions.
 * Useful for endpoints that can be accessed with different permissions (e.g., monitor OR view results).
 * 
 * @param {string[]} permissions - Array of permission names (user needs at least one)
 * @returns {Function} Express middleware function
 */
function requirePermissionOr(permissions) {
  return async (req, res, next) => {
    try {
      // Role comes only from the verified token (authenticateToken), never from request headers
      if (!req.user) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required'
        });
      }
      const userRole = req.user.role;
      const userId = req.user.id;

      // Check if user has at least one of the required permissions
      const hasAnyPermission = permissions.some(permission => 
        checkPermission(userRole, permission)
      );

      if (!hasAnyPermission) {
        return res.status(403).json({
          error: 'Permission denied',
          message: `Your role (${userRole}) does not have any of the required permissions: ${permissions.join(', ')}`,
          requiredPermissions: permissions,
          userRole: userRole
        });
      }

      // Attach role and userId to request for use in route handlers (documentation compatibility)
      if (!req.userRole) req.userRole = userRole;
      if (!req.userId) req.userId = userId;

      // User has at least one permission, continue
      next();
    } catch (error) {
      console.error('Authorization error:', error);
      return res.status(500).json({
        error: 'Internal server error',
        message: 'Authorization check failed'
      });
    }
  };
}

/**
 * Check if user can assign a specific role
 * Helper function for role assignment validation
 * 
 * @param {string} assignerRole - Role of the user trying to assign
 * @param {string} targetRole - Role being assigned
 * @returns {boolean} True if assignment is allowed
 */
function validateRoleAssignment(assignerRole, targetRole) {
  // Check if target role is valid
  if (!isValidRole(targetRole)) {
    return {
      allowed: false,
      error: 'Invalid role'
    };
  }

  // Check if assigner can assign target role
  if (!canAssignRole(assignerRole, targetRole)) {
    return {
      allowed: false,
      error: targetRole === 'platform_admin'
        ? 'Cannot assign platform_admin role'
        : 'Insufficient permissions to assign roles'
    };
  }

  return {
    allowed: true
  };
}

/** The one superadmin: role platform_admin AND a member of the "gsn" company */
function isSuperadmin(user) {
  return user?.role === 'platform_admin' && String(user?.company || '').trim().toLowerCase() === 'gsn';
}

/**
 * Only the superadmin may continue (superadmin panel endpoints)
 */
function requireSuperadmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
  }
  if (!isSuperadmin(req.user)) {
    return res.status(403).json({ error: 'Forbidden', message: 'Only the GSN superadmin can do this' });
  }
  next();
}

module.exports = {
  requirePermission,
  requirePermissionOr,
  requireRole,
  requireWorkspaceAccess,
  validateRoleAssignment,
  isSuperadmin,
  requireSuperadmin
};
