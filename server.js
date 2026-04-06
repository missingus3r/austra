import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import path from 'path';
import { fileURLToPath } from 'url';

// Config
dotenv.config();

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// API Routes
import authRoutes from './src/routes/auth.js';
import newsRoutes from './src/routes/news.js';
import enlacesminteriorRoutes from './src/routes/enlacesminterior.js';
import adminRoutes from './src/routes/admin.js';
import notificationRoutes from './src/routes/notifications.js';
import pricingRoutes from './src/routes/pricing.js';
import exchangeRatesRoutes from './src/routes/exchangeRates.js';
import forumRoutes from './src/routes/forum.js';
import reportsRoutes from './src/routes/reports.js';
import dashboardRoutes from './src/routes/dashboard.js';
import preferencesRoutes from './src/routes/preferences.js';
import busesRoutes from './src/routes/buses.js';
import weatherRoutes from './src/routes/weather.js';
import assistantRoutes from './src/routes/assistant.js';

// View Routes
import viewRoutes from './src/routes/views.js';

// Middleware
import { errorHandler } from './src/middleware/errorHandler.js';
import { trackPageVisit } from './src/middleware/pageTracking.js';

// Auth0
import { auth0Middleware } from './src/config/auth0.js';

// Sockets
import { initializeSocketHandlers } from './src/sockets/eventHandlers.js';

// Jobs
import { startCronJobs } from './src/jobs/index.js';

// Logger
import logger from './src/utils/logger.js';

// Montevideo Transport API Token Manager
import tokenManager from './src/services/montevideoTokenManager.js';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN,
    credentials: true
  }
});

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Session middleware with MongoDB store
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'austra.sid', // Custom cookie name
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    collectionName: 'sessions',
    ttl: 24 * 60 * 60, // 24 hours in seconds
    autoRemove: 'native', // Use MongoDB's native TTL index
    touchAfter: 24 * 3600 // Only update session once per 24 hours (unless modified)
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // 'none' required for cross-site Auth0 redirects in production
    path: '/', // Ensure cookie is sent for all paths
    domain: process.env.COOKIE_DOMAIN || undefined // Set domain for production (e.g., '.yourdomain.com')
  },
  rolling: true, // Reset expiration on every request
  proxy: process.env.NODE_ENV === 'production' // Trust proxy in production (needed for secure cookies behind reverse proxy)
}));

// Auth0 middleware - attaches /login, /logout, and /callback routes
app.use(auth0Middleware);

// Middleware
app.use(helmet({
  contentSecurityPolicy: false // Allow inline scripts for MapLibre
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// MongoDB connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => logger.info('MongoDB connected successfully'))
  .catch(err => {
    logger.error('MongoDB connection error:', err);
    process.exit(1);
  });

// Make io accessible to routes
app.set('io', io);

// Middleware simplificado: pasa usuario a las vistas
app.use((req, res, next) => {
  // Verificar autenticación OIDC o sesión Express
  const isOidcAuth = req.oidc?.isAuthenticated() || false;
  const hasExpressSession = req.session?.user ? true : false;

  const isAuthenticated = isOidcAuth || hasExpressSession;

  // Si está autenticado en OIDC, usar datos de OIDC
  if (isOidcAuth) {
    res.locals.user = req.oidc.user;
  }
  // Si solo tiene sesión Express, usar datos de la sesión
  else if (hasExpressSession) {
    res.locals.user = req.session.user;
  }
  else {
    res.locals.user = null;
  }

  res.locals.isAuthenticated = isAuthenticated;
  next();
});

// Track page visits (after session middleware so we can access user info)
app.use(trackPageVisit);

// API Routes
app.use('/auth', authRoutes);
app.use('/news', newsRoutes);
app.use('/enlacesminterior', enlacesminteriorRoutes);
app.use('/admin', adminRoutes);
app.use('/notifications', notificationRoutes);
app.use('/pricing', pricingRoutes);
app.use('/exchange-rates', exchangeRatesRoutes);
app.use('/forum', forumRoutes);
app.use('/reports', reportsRoutes);
app.use('/preferences', preferencesRoutes);
app.use('/api/buses', busesRoutes);
app.use('/weather', weatherRoutes);
app.use('/assistant', assistantRoutes);

// Dashboard routes (includes both view and API routes)
app.use('/', dashboardRoutes);

// View Routes (serve HTML pages)
app.use('/', viewRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Error handler (must be last)
app.use(errorHandler);

// Socket.IO
initializeSocketHandlers(io);

// Start cron jobs
startCronJobs(io);

// Initialize Montevideo Transport API Token Manager
tokenManager.initialize().catch(err => {
  logger.error('Failed to initialize Montevideo API token manager:', err);
});

// Start server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  tokenManager.stop();
  httpServer.close(() => {
    logger.info('HTTP server closed');
  });
  await mongoose.connection.close();
  process.exit(0);
});

export { io };
