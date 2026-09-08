/**
 * Permission Utilities
 * 
 * Defines the permission matrix for role-based access control (RBAC).
 * Each role has a set of permissions that determine what actions they can perform.
 */

/**
 * Permission matrix mapping roles to their allowed permissions
 */
const PERMISSIONS = {
  platform_admin: [
    'manageGlobalConfig',
    'removeUsers',
    'manageWorkspace',
    'manageProjects',
    'manageWorkspaceUsers',
    'assignRoles',
    'deleteProjects',
    'deleteOwnInference',
    'uploadDatasets',
    'deleteDatasets',
    'viewRawDatasetImages',
    'startTraining',
    'tuneHyperparameters',
    'viewTrainingMetrics',
    'runInference',
    'monitorInference',
    'viewInferenceResults',
    'viewProjects',
    'viewDatasets',
    'viewModels',
    'viewInference',
    'viewActions',
    'manageActions',
    'approveActions'
  ],
  workspace_admin: [
    'manageWorkspace',
    'manageProjects',
    'manageWorkspaceUsers',
    'assignRoles',
    'deleteProjects',
    'uploadDatasets',
    'deleteDatasets',
    'viewRawDatasetImages',
    'startTraining',
    'tuneHyperparameters',
    'viewTrainingMetrics',
    'runInference',
    'monitorInference',
    'viewInferenceResults',
    'viewProjects',
    'viewDatasets',
    'viewModels',
    'viewInference',
    'viewActions',
    'manageActions',
    'approveActions'
  ],
  ml_engineer: [
    'uploadDatasets',
    'viewRawDatasetImages',
    'startTraining',
    'tuneHyperparameters',
    'viewTrainingMetrics',
    'viewInferenceResults',
    'viewProjects',
    'viewDatasets',
    'viewModels',
    'viewInference',
    'viewActions'
  ],
  operator: [
    'runInference',
    'monitorInference',
    'viewInferenceResults',
    'deleteOwnInference',
    'viewTrainingMetrics',
    'viewProjects',
    'viewDatasets',
    'viewModels',
    'viewInference',
    'viewRawDatasetImages',
    'viewActions',
    'manageActions'
  ],
  viewer: [
    'viewProjects',
    'viewDatasets',
    'viewModels',
    'viewInference',
    'viewInferenceResults',
    'viewRawDatasetImages',
    'viewActions'
  ]
};

/**
 * Valid role names
 */
const VALID_ROLES = [
  'platform_admin',
  'workspace_admin',
  'ml_engineer',
  'operator',
  'viewer'
];

/**
 * Check if a role has a specific permission
 * 
 * @param {string} role - User role
 * @param {string} permission - Permission to check
 * @returns {boolean} True if role has permission, false otherwise
 */
function checkPermission(role, permission) {
  if (!role || !permission) {
    return false;
  }

  const rolePermissions = PERMISSIONS[role];
  if (!rolePermissions) {
    return false;
  }

  return rolePermissions.includes(permission);
}

/**
 * Get all permissions for a role
 * 
 * @param {string} role - User role
 * @returns {string[]} Array of permissions for the role, empty array if role not found
 */
function getRolePermissions(role) {
  if (!role) {
    return [];
  }

  return PERMISSIONS[role] || [];
}

/**
 * Check if a role is valid
 * 
 * @param {string} role - Role to validate
 * @returns {boolean} True if role is valid, false otherwise
 */
function isValidRole(role) {
  return VALID_ROLES.includes(role);
}

/**
 * Check if a role can assign another role
 * 
 * @param {string} assignerRole - Role of the user trying to assign
 * @param {string} targetRole - Role being assigned
 * @returns {boolean} True if assignment is allowed, false otherwise
 */
function canAssignRole(assignerRole, targetRole) {
  // platform_admin can assign any role
  if (assignerRole === 'platform_admin') {
    return isValidRole(targetRole);
  }

  // workspace_admin can assign workspace roles (not platform_admin)
  if (assignerRole === 'workspace_admin') {
    const allowedRoles = ['workspace_admin', 'ml_engineer', 'operator', 'viewer'];
    return allowedRoles.includes(targetRole);
  }

  // Other roles cannot assign roles
  return false;
}

/**
 * Get user role from request headers
 * @param {Object} req - Express request object
 * @returns {string|null} - User role or null
 */
function getUserRoleFromHeaders(req) {
  return req.headers['x-user-role'] || null;
}

/**
 * Get user ID from request headers
 * @param {Object} req - Express request object
 * @returns {string|null} - User ID or null
 */
function getUserIdFromHeaders(req) {
  return req.headers['x-user-id'] || null;
}

/**
 * Verify user role from database (for security)
 * This should query your user/profile database to verify the role.
 * 
 * NOTE: Currently returns the claimed role as valid. Implement database verification
 * by querying your user database (e.g., Supabase profiles table, MongoDB users collection).
 * 
 * @param {string} userId - User ID
 * @param {string} claimedRole - Role claimed in headers
 * @returns {Promise<{valid: boolean, role: string|null}>}
 */
async function verifyUserRole(userId, claimedRole) {
  // TODO: Implement database query to verify user role
  // Example for MongoDB:
  // const User = require('../models/User');
  // const user = await User.findById(userId);
  // if (!user) return { valid: false, role: null };
  // return { valid: user.role === claimedRole, role: user.role };
  
  // Example for Supabase:
  // const { getSupabaseClient } = require('../services/supabaseService');
  // const supabase = getSupabaseClient();
  // const { data: profile, error } = await supabase
  //   .from('profiles')
  //   .select('role')
  //   .eq('id', userId)
  //   .single();
  // if (error || !profile) return { valid: false, role: null };
  // return { valid: profile.role === claimedRole, role: profile.role };
  
  // For now, return the claimed role (backend should implement proper verification)
  // This maintains backward compatibility while allowing future database verification
  return { valid: true, role: claimedRole };
}

// Export rolePermissions as alias for PERMISSIONS (for backward compatibility with documentation)
const rolePermissions = PERMISSIONS;

module.exports = {
  PERMISSIONS,
  rolePermissions, // Alias for documentation compatibility
  VALID_ROLES,
  checkPermission,
  getRolePermissions,
  isValidRole,
  canAssignRole,
  getUserRoleFromHeaders,
  getUserIdFromHeaders,
  verifyUserRole
};
