require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { initQueues } = require('./queue');
const datasetRoutes = require('./routes/datasets');
const annotationRoutes = require('./routes/annotations');
const trainingRoutes = require('./routes/training');
const modelRoutes = require('./routes/models');
const inferenceRoutes = require('./routes/inference');
const mobileInspectRoutes = require('./routes/mobileInspect');
const aiRoutes = require('./routes/ai');
const dashboardRoutes = require('./routes/dashboard');
const analyticsRoutes = require('./routes/analytics');
const auditRoutes = require('./routes/audit');
const actionRoutes = require('./routes/actions');
const projectRoutes = require('./routes/projects');
const demoExtinguisherRoutes = require('./routes/demoExtinguisherRoutes');
const { authenticateToken } = require('./middleware/authMiddleware');
const dns = require('dns');

dns.setServers(['8.8.8.8', '1.1.1.1']);

/**
 * Main Server File
 * 
 * This is the entry point of your backend application.
 * It sets up Express, connects to MongoDB, and registers routes.
 */

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Middleware: Parse JSON request bodies
// This allows you to read JSON data from POST/PUT requests
app.use(express.json());

// ✅ Middleware: Parse URL-encoded form data
app.use(express.urlencoded({ extended: true }));

// --- production-safe CORS (replace existing CORS middleware) ---
const allowedOrigin = process.env.CORS_ORIGIN || '*'; // set in Azure later

app.set('trust proxy', 1); // required for Azure behind proxy

app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Native apps (Expo / Android) often send no Origin header.
  if (!origin || allowedOrigin === '*' || origin === allowedOrigin) {
    res.header('Access-Control-Allow-Origin', !origin || allowedOrigin === '*' ? '*' : origin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Id, X-User-Role, X-User-Company, X-User-Email, X-User-Company-Id');
    res.header('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    return next();
  }
  return res.status(403).json({ error: 'CORS origin denied' });
});

// ✅ Health check endpoint (public, no authentication required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ✅ Global authentication middleware for all /api routes
// This ensures all API endpoints require authentication by default
// Public routes (like /health) are registered before this middleware
app.use('/api', (req, res, next) => {
  // Skip authentication for OPTIONS requests (CORS preflight)
  if (req.method === 'OPTIONS') {
    return next();
  }
  // Skip authentication for POST /api/inference/edge/live (edge device sends inference results; no user headers in MVP)
  if (req.method === 'POST' && req.path === '/inference/edge/live') {
    return next();
  }
  // Apply authentication middleware
  authenticateToken(req, res, next);
});

// ✅ Request logging middleware (for debugging)
app.use((req, res, next) => {
  // Log ALL requests (for debugging thumbnail issue)
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`, {
    query: Object.keys(req.query).length > 0 ? req.query : undefined,
    origin: req.headers.origin,
    referer: req.headers.referer
  });
  next();
});

// ✅ Register annotation routes FIRST
// All routes in routes/annotations.js will be prefixed with /api/dataset
// IMPORTANT: Mount before datasetRoutes so /:datasetId/annotations/:annotationId
// cannot be swallowed by generic dataset version delete routes.
app.use('/api/dataset', annotationRoutes);

// ✅ Register dataset routes
// All routes in routes/datasets.js will be prefixed with /api/dataset
app.use('/api/dataset', datasetRoutes);

// ✅ Register training routes
// All routes in routes/training.js will be prefixed with /api/train
app.use('/api/train', trainingRoutes);

// ✅ Register model registry routes
// All routes in routes/models.js will be prefixed with /api/models
app.use('/api/models', modelRoutes);

// ✅ Register inference routes
// All routes in routes/inference.js will be prefixed with /api/inference
app.use('/api/inference', inferenceRoutes);
app.use('/api/mobile-inspect', mobileInspectRoutes);

// ✅ Register AI routes
// All routes in routes/ai.js will be prefixed with /api/ai
app.use('/api/ai', aiRoutes);

// ✅ Register dashboard routes
// All routes in routes/dashboard.js will be prefixed with /api/dashboard
app.use('/api/dashboard', dashboardRoutes);

// ✅ Register analytics routes
// All routes in routes/analytics.js will be prefixed with /api/analytics
app.use('/api/analytics', analyticsRoutes);

// ✅ Register audit routes
// All routes in routes/audit.js will be prefixed with /api/audit
app.use('/api/audit', auditRoutes);

// ✅ Register action item routes (corrosion dashboard: open actions/overdue reviews)
// All routes in routes/actions.js will be prefixed with /api/actions
app.use('/api/actions', actionRoutes);

// ✅ Register project routes (keeps Mongo's company/project-scoped
// collections in sync with a project's name after a rename in Supabase)
// All routes in routes/projects.js will be prefixed with /api/projects
app.use('/api/projects', projectRoutes);

// ✅ Register temporary extinguisher OCR demo routes
// All routes in routes/demoExtinguisherRoutes.js will be prefixed with /api/demo/extinguisher
app.use('/api/demo/extinguisher', demoExtinguisherRoutes);

// ✅ Register user management routes
// All routes in routes/users.js will be prefixed with /api/users
const userRoutes = require('./routes/users');
app.use('/api/users', userRoutes);

// ✅ Register list datasets endpoint (plural) - separate route for clarity
// GET /api/datasets - List all datasets
const { listDatasets } = require('./controllers/datasetController');
const { requirePermission } = require('./middleware/authorizationMiddleware');
app.get('/api/datasets', authenticateToken, requirePermission('viewDatasets'), listDatasets);

// ✅ 404 handler (route not found)
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path
  });
});

// ✅ Error handler middleware
// ⚠️ CAUTION: This catches all errors from route handlers
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

/**
 * Connect to MongoDB and start server
 */
const startServer = async () => {
  try {
    // ✅ Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/visiondb';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // ✅ Initialize Bull queues (after MongoDB connection)
    // This ensures Redis/Bull starts after MongoDB is ready
    try {
      initQueues();
      console.log('✅ Queues initialized in API');
    } catch (error) {
      console.error('❌ Failed to initialize queues:', error);
      process.exit(1);
    }

    // ✅ Start Express server
    app.listen(PORT, () => {
      console.log(`✅ Server running on http://localhost:${PORT}`);
      console.log(`📁 Dataset upload: POST http://localhost:${PORT}/api/dataset/upload`);
      console.log(`📊 Dataset status: GET http://localhost:${PORT}/api/dataset/:datasetId/status`);
      console.log(`🚀 Training start: POST http://localhost:${PORT}/api/train`);
      console.log(`📈 Training status: GET http://localhost:${PORT}/api/train/:jobId/status`);
      console.log(`🤖 Models list: GET http://localhost:${PORT}/api/models?company=X&project=Y`);
      console.log(`📦 Model details: GET http://localhost:${PORT}/api/models/:modelId`);
      console.log(`🗑️  Model delete: DELETE http://localhost:${PORT}/api/models/:modelId`);
      console.log(`📋 Dataset dependencies: GET http://localhost:${PORT}/api/dataset/:datasetId/dependencies`);
      console.log(`🗑️  Dataset delete: DELETE http://localhost:${PORT}/api/dataset/:datasetId`);
      console.log(`📋 Inference list: GET http://localhost:${PORT}/api/inference?company=X&project=Y`);
      console.log(`🔮 Inference start: POST http://localhost:${PORT}/api/inference/start`);
      console.log(`📊 Inference status: GET http://localhost:${PORT}/api/inference/:inferenceId/status`);
      console.log(`📋 Inference results: GET http://localhost:${PORT}/api/inference/:inferenceId/results`);
      console.log(`🖼️  Inference images: GET http://localhost:${PORT}/api/inference/:inferenceId/image/:filename`);
      console.log(`❌ Inference cancel: POST http://localhost:${PORT}/api/inference/:inferenceId/cancel`);
      console.log(`🗑️  Inference delete: DELETE http://localhost:${PORT}/api/inference/:inferenceId`);
      console.log(`🤖 Ask AI: POST http://localhost:${PORT}/api/ai/ask`);
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// ✅ Handle MongoDB connection errors
mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected');
});

// ✅ Global error handlers
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// ✅ Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});

// ✅ Start the server
startServer();

module.exports = app;

