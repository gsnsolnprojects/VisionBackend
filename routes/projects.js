const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/authorizationMiddleware');
const { renameProject } = require('../controllers/projectController');

/**
 * Project Routes
 *
 * Supabase remains the source of truth for a project's canonical name.
 * These routes keep MongoDB's company/project-scoped collections in sync
 * with that name, since Mongo has no Project collection of its own.
 */

// POST /api/projects/rename - Cascade-rename a project across Mongo collections
// (POST, not PATCH: React Native's networking layer on Android has a known
// history of unreliable PATCH support, surfacing as a generic "Network
// request failed" even when the server is reachable and correct.)
router.post('/rename', authenticateToken, requirePermission('manageProjects'), renameProject);

module.exports = router;
