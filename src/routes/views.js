import express from 'express';
import { checkMaintenance } from '../middleware/maintenanceCheck.js';
import { getAuthenticatedUser } from '../config/auth0.js';
import { Donor } from '../models/index.js';

const router = express.Router();

// Middleware to prevent caching of pages with auth state
router.use((req, res, next) => {
  // Evitar caché en el navegador para páginas que dependen del estado de autenticación
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  next();
});

// Middleware to inject user and auth info into all views
router.use((req, res, next) => {
  const isOidcAuthenticated = typeof req.oidc?.isAuthenticated === 'function'
    ? req.oidc.isAuthenticated()
    : false;
  const sessionUser = req.session?.user || null;
  const hasSessionUser = !!sessionUser;
  const oidcUser = isOidcAuthenticated ? (req.oidc?.user || null) : null;

  res.locals.isAuthenticated = !!res.locals.isAuthenticated || isOidcAuthenticated || hasSessionUser;
  res.locals.user = res.locals.user || oidcUser || sessionUser || null;

  next();
});

/**
 * Home / Landing page
 */
router.get('/', (req, res) => {
  res.render('landing', {
    title: 'AUSTRA - Plataforma Integral',
    page: 'landing'
  });
});

/**
 * Detalle plataforma Austra
 */
router.get('/plataforma', (req, res) => {
  res.render('plataforma', {
    title: 'AUSTRA Plataforma - Capacidades y Experiencia',
    page: 'plataforma'
  });
});

/**
 * Social y crowdfunding
 */
router.get('/social', (req, res) => {
  res.render('social', {
    title: 'Social Comunitario - Austra',
    page: 'social'
  });
});

/**
 * News page - now handled by news.js router
 */

/**
 * Forum page
 */
router.get('/forum', checkMaintenance('forum'), (req, res) => {
  res.render('forum', {
    title: 'Foro Comunitario - Austra',
    page: 'forum'
  });
});

/**
 * Austra Forum - Thread list
 */
router.get('/forum-austra', checkMaintenance('forum'), (req, res) => {
  res.render('forum-austra', {
    title: 'Foro Austra - Austra',
    page: 'forum'
  });
});

/**
 * Austra Forum - Thread view
 */
router.get('/forum-thread/:id', checkMaintenance('forum'), (req, res) => {
  res.render('forum-thread', {
    title: 'Thread - Foro Austra',
    page: 'forum'
  });
});

/**
 * Enlaces Ministerio del Interior page
 */
router.get('/enlacesminterior', (req, res) => {
  res.render('enlacesminterior', {
    title: 'Enlaces Oficiales - Ministerio del Interior - Austra',
    page: 'enlacesminterior'
  });
});

/**
 * Pricing page
 */
router.get('/pricing', (req, res) => {
  res.render('pricing', {
    title: 'Planes y Precios - Austra',
    page: 'pricing'
  });
});

/**
 * Nexus page - Geospatial data and maps
 */
router.get('/nexus', (req, res) => {
  res.render('nexus', {
    title: 'Nexus - Austra',
    page: 'nexus'
  });
});

/**
 * Donors page
 */
router.get('/donadores', (req, res) => {
  res.render('donadores', {
    title: 'Muro de Donadores - Austra',
    page: 'donadores'
  });
});

/**
 * Profile page (requires auth)
 */
router.get('/perfil', async (req, res) => {
  const user = await getAuthenticatedUser(req);

  if (!user) {
    return res.redirect('/login');
  }
  res.render('perfil', {
    title: 'Mi Perfil - Austra',
    page: 'perfil',
    user
  });
});

/**
 * Login - Manejado automáticamente por Auth0 middleware en /login
 * No se define ruta aquí para evitar conflictos
 */

/**
 * Privacy policy
 */
router.get('/privacy', (req, res) => {
  res.render('privacy', {
    title: 'Política de Privacidad - Austra',
    page: 'privacy'
  });
});

/**
 * Terms of service
 */
router.get('/terms', (req, res) => {
  res.render('terms', {
    title: 'Términos de Servicio - Austra',
    page: 'terms'
  });
});

/**
 * Admin page (requires admin role)
 */
router.get('/admin', async (req, res) => {
  const user = await getAuthenticatedUser(req);

  if (!user) {
    return res.redirect('/login');
  }

  if (user.role !== 'admin') {
    return res.status(403).send('Acceso denegado - Se requiere rol de administrador');
  }

  res.render('admin', {
    title: 'Panel de Administración - Austra',
    page: 'admin',
    user
  });
});

/**
 * Logout - Manejado automáticamente por Auth0 middleware en /logout
 * No se define ruta aquí para permitir que Auth0 maneje el cierre de sesión completo
 */

/**
 * API: Get all donors (public)
 */
router.get('/api/donors', async (req, res) => {
  try {
    const donors = await Donor.getAllDonors();
    res.json({
      success: true,
      donors
    });
  } catch (error) {
    console.error('Error fetching donors:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener donadores'
    });
  }
});

export default router;
