import express from 'express';
import mongoose from 'mongoose';
import axios from 'axios';
import NewsEvent from '../models/NewsEvent.js';
import { AdminPost, Notification, User, ForumThread, ForumComment, ForumSettings, PricingSettings, PageVisit, SystemSettings, ApiToken, Donor } from '../models/index.js';
import { runNewsIngestion } from '../jobs/newsIngestion.js';
import { runScheduledCleanup, reloadCronJobs } from '../jobs/index.js';
import logger from '../utils/logger.js';
import { Parser } from 'json2csv';
import ExcelJS from 'exceljs';
import { getMaintenanceStatus } from '../middleware/maintenanceCheck.js';
import { getAuthenticatedUser } from '../config/auth0.js';

const router = express.Router();

// Middleware para verificar que el usuario es admin
const requireAdmin = async (req, res, next) => {
  const user = await getAuthenticatedUser(req);

  if (!user) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Acceso denegado - Se requiere rol de administrador' });
  }

  // Ensure we always have the admin MongoDB _id available for downstream checks
  if (!user._id && user.email) {
    try {
      const dbUser = await User.findOne({ email: user.email }).select('_id').lean();
      if (dbUser?._id) {
        user._id = dbUser._id.toString();
      }
    } catch (error) {
      logger.warn('No se pudo recuperar el _id del admin autenticado', { error: error.message });
    }
  }

  req.user = user;

  next();
};

const sanitizeUser = (user) => {
  if (!user) return null;

  const plainUser = typeof user.toObject === 'function' ? user.toObject() : user;

  return {
    id: plainUser._id ? plainUser._id.toString() : null,
    email: plainUser.email || '',
    name: plainUser.name || '',
    role: plainUser.role || 'user',
    banned: !!plainUser.banned,
    bannedUntil: plainUser.bannedUntil || null,
    createdAt: plainUser.createdAt || null,
    updatedAt: plainUser.updatedAt || null,
    lastLogin: plainUser.lastLogin || null,
    reportCount: plainUser.reportCount || 0,
    validationCount: plainUser.validationCount || 0,
    strikes: plainUser.strikes || 0
  };
};

/**
 * GET /admin/stats
 * Obtener estadísticas del sistema
 */
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    // Fecha de hace 24 horas
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Obtener estadísticas básicas
    const [
      totalNews,
      totalUsers,
      usersToday
    ] = await Promise.all([
      NewsEvent.countDocuments(),
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: yesterday } })
    ]);

    // Estado de las conexiones
    const mongoConnected = mongoose.connection.readyState === 1;

    const stats = {
      totalUsers,
      usersToday,
      totalNews,
      mongoConnected,
      serverUptime: process.uptime(),
      timestamp: new Date()
    };

    res.json(stats);
  } catch (error) {
    logger.error('Error getting admin stats:', error);
    res.status(500).json({
      error: 'Error al obtener estadísticas',
      details: error.message
    });
  }
});

/**
 * GET /admin/users
 * Get user statistics and recent users
 */
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const lastMonth = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // User counts
    const [
      totalUsers,
      usersToday,
      usersThisWeek,
      usersThisMonth,
      adminUsers,
      regularUsers
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: yesterday } }),
      User.countDocuments({ createdAt: { $gte: lastWeek } }),
      User.countDocuments({ createdAt: { $gte: lastMonth } }),
      User.countDocuments({ role: 'admin' }),
      User.countDocuments({ role: { $ne: 'admin' } })
    ]);

    // Recent users (last 5)
    const recentUsers = await User.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('email name role createdAt lastLogin')
      .lean();

    // Users by day (last 7 days)
    const usersByDay = await Promise.all(
      Array.from({ length: 7 }, async (_, i) => {
        const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        date.setHours(0, 0, 0, 0);
        const nextDate = new Date(date.getTime() + 24 * 60 * 60 * 1000);

        const count = await User.countDocuments({
          createdAt: { $gte: date, $lt: nextDate }
        });

        return {
          date: date.toISOString().split('T')[0],
          count
        };
      })
    );

    res.json({
      success: true,
      stats: {
        total: totalUsers,
        today: usersToday,
        thisWeek: usersThisWeek,
        thisMonth: usersThisMonth,
        byRole: {
          admin: adminUsers,
          regular: regularUsers
        }
      },
      recentUsers,
      usersByDay: usersByDay.reverse()
    });
  } catch (error) {
    logger.error('Error getting user stats:', error);
    res.status(500).json({
      error: 'Error al obtener estadísticas de usuarios',
      details: error.message
    });
  }
});

/**
 * GET /admin/users/list
 * Retrieve full user list for management actions
 */
router.get('/users/list', requireAdmin, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter = {};

    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { email: regex },
        { name: regex }
      ];
    }

    const [users, totalCount] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('email name role banned bannedUntil createdAt updatedAt lastLogin reportCount validationCount strikes')
        .lean(),
      User.countDocuments(filter)
    ]);

    res.json({
      success: true,
      count: users.length,
      totalCount: totalCount,
      page: page,
      totalPages: Math.ceil(totalCount / limit),
      limit: limit,
      users: users.map(sanitizeUser)
    });
  } catch (error) {
    logger.error('Error fetching admin user list:', error);
    res.status(500).json({
      error: 'Error al obtener la lista de usuarios',
      details: error.message
    });
  }
});

/**
 * PATCH /admin/users/:id/status
 * Update banned status of user (block/unblock)
 */
router.patch('/users/:id/status', requireAdmin, async (req, res) => {
  try {
    const { banned } = req.body;
    const userId = req.params.id;

    if (typeof banned !== 'boolean') {
      return res.status(400).json({ error: 'El campo "banned" es requerido y debe ser booleano' });
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'ID de usuario inválido' });
    }

    // Validate user._id exists before using it
    const adminId = req.user?._id ? req.user._id.toString() : null;
    if (adminId && adminId === userId && banned) {
      return res.status(400).json({ error: 'No podés bloquear tu propia cuenta de administrador' });
    }

    const targetUser = await User.findById(userId);

    if (!targetUser) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (targetUser.role === 'admin' && targetUser._id.toString() !== req.user?._id?.toString()) {
      return res.status(403).json({ error: 'No está permitido modificar el estado de otros administradores' });
    }

    targetUser.banned = banned;
    targetUser.bannedUntil = banned ? (req.body.bannedUntil ? new Date(req.body.bannedUntil) : null) : null;

    await targetUser.save();

    logger.info(`Admin ${req.user?.email} ${banned ? 'bloqueó' : 'desbloqueó'} al usuario ${targetUser.email}`);

    res.json({
      success: true,
      message: banned ? 'Usuario bloqueado correctamente' : 'Usuario desbloqueado correctamente',
      user: sanitizeUser(targetUser)
    });
  } catch (error) {
    logger.error('Error updating user status:', error);
    res.status(500).json({
      error: 'Error al actualizar el estado del usuario',
      details: error.message
    });
  }
});

/**
 * DELETE /admin/users/:id
 * Remove a user account
 */
router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'ID de usuario inválido' });
    }

    if (req.user?._id && req.user._id.toString() === userId) {
      return res.status(400).json({ error: 'No podés eliminar tu propia cuenta' });
    }

    const targetUser = await User.findById(userId);

    if (!targetUser) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (targetUser.role === 'admin') {
      return res.status(403).json({ error: 'No está permitido eliminar cuentas de administrador' });
    }

    await User.deleteOne({ _id: userId });

    logger.warn(`Admin ${req.user?.email} eliminó al usuario ${targetUser.email}`);

    res.json({
      success: true,
      message: 'Usuario eliminado correctamente'
    });
  } catch (error) {
    logger.error('Error deleting user:', error);
    res.status(500).json({
      error: 'Error al eliminar el usuario',
      details: error.message
    });
  }
});

/**
 * POST /admin/posts
 * Create a new admin post (announcement)
 */
router.post('/posts', requireAdmin, async (req, res) => {
  try {
    const { title, content, priority } = req.body;

    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }

    // Validate user.uid exists before using it
    if (!req.user || !req.user.uid) {
      return res.status(401).json({ error: 'User authentication error - UID missing' });
    }

    const post = new AdminPost({
      title,
      content,
      priority: priority || 'normal',
      authorUid: req.user.uid
    });

    await post.save();

    // Create notifications for all users
    const users = await User.find({ role: { $ne: 'admin' } });

    const notificationPromises = users.map(user =>
      Notification.createNotification(
        user.uid,
        'admin_post',
        `📢 ${title}`,
        content.substring(0, 200) + (content.length > 200 ? '...' : ''),
        { postId: post._id, priority: post.priority }
      )
    );

    await Promise.all(notificationPromises);

    // Emit socket event
    const io = req.app.get('io');
    if (io) {
      io.emit('admin-post', {
        id: post._id,
        title: post.title,
        priority: post.priority
      });
    }

    logger.info('Admin post created', {
      postId: post._id,
      authorUid: req.user.uid,
      usersNotified: users.length
    });

    res.status(201).json({
      message: 'Post created successfully',
      post,
      usersNotified: users.length
    });
  } catch (error) {
    logger.error('Error creating admin post:', error);
    res.status(500).json({
      error: 'Error creating post',
      details: error.message
    });
  }
});

/**
 * GET /admin/posts
 * Get all admin posts (including unpublished)
 */
router.get('/posts', requireAdmin, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const posts = await AdminPost.find()
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(offset));

    const total = await AdminPost.countDocuments();

    res.json({
      posts,
      total
    });
  } catch (error) {
    logger.error('Error getting admin posts:', error);
    res.status(500).json({
      error: 'Error getting posts',
      details: error.message
    });
  }
});

/**
 * PATCH /admin/posts/:id
 * Update admin post
 */
router.patch('/posts/:id', requireAdmin, async (req, res) => {
  try {
    const { title, content, priority, published } = req.body;

    const post = await AdminPost.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (title !== undefined) post.title = title;
    if (content !== undefined) post.content = content;
    if (priority !== undefined) post.priority = priority;
    if (published !== undefined) post.published = published;

    await post.save();

    logger.info('Admin post updated', {
      postId: post._id,
      updatedBy: req.user.uid
    });

    res.json({
      message: 'Post updated successfully',
      post
    });
  } catch (error) {
    logger.error('Error updating admin post:', error);
    res.status(500).json({
      error: 'Error updating post',
      details: error.message
    });
  }
});

/**
 * DELETE /admin/posts/:id
 * Delete admin post
 */
router.delete('/posts/:id', requireAdmin, async (req, res) => {
  try {
    const post = await AdminPost.findByIdAndDelete(req.params.id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    logger.info('Admin post deleted', {
      postId: post._id,
      deletedBy: req.user.uid
    });

    res.json({
      message: 'Post deleted successfully'
    });
  } catch (error) {
    logger.error('Error deleting admin post:', error);
    res.status(500).json({
      error: 'Error deleting post',
      details: error.message
    });
  }
});

/**
 * POST /admin/news/ingest
 * Manually trigger news ingestion from RSS feeds
 * Automatically filters articles by security keywords from .env
 */
router.post('/news/ingest', requireAdmin, async (req, res) => {
  try {
    const securityKeywords = process.env.NEWS_SECURITY_KEYWORDS
      ? process.env.NEWS_SECURITY_KEYWORDS.split(',').map(k => k.trim()).slice(0, 5)
      : [];

    logger.info('Manual news ingestion triggered', {
      triggeredBy: req.user.uid,
      securityFilterEnabled: securityKeywords.length > 0
    });

    // Run news ingestion in background (always with security keywords filter)
    const io = req.app.get('io');
    runNewsIngestion(io).then(result => {
      logger.info('Manual news ingestion completed', result);
    }).catch(error => {
      logger.error('Manual news ingestion failed:', error);
    });

    res.json({
      message: 'News ingestion started (filtering by security keywords)',
      securityKeywordsPreview: securityKeywords.length > 0
        ? `${securityKeywords.join(', ')}...`
        : 'No keywords configured',
      note: 'This process runs in the background and may take several minutes'
    });
  } catch (error) {
    logger.error('Error triggering news ingestion:', error);
    res.status(500).json({
      error: 'Error triggering news ingestion',
      details: error.message
    });
  }
});

/**
 * DELETE /admin/news/clear
 * Delete all news events from the database
 */
router.delete('/news/clear', requireAdmin, async (req, res) => {
  try {
    logger.warn('Mass news deletion triggered', {
      triggeredBy: req.user.uid
    });

    const result = await NewsEvent.deleteMany({});

    logger.info('News deletion completed', {
      deletedCount: result.deletedCount,
      deletedBy: req.user.uid
    });

    res.json({
      message: 'All news deleted successfully',
      deletedCount: result.deletedCount
    });
  } catch (error) {
    logger.error('Error deleting news:', error);
    res.status(500).json({
      error: 'Error deleting news',
      details: error.message
    });
  }
});

/**
 * GET /admin/news/stats
 * Get news ingestion statistics
 * Query params: from, to (date range)
 */
router.get('/news/stats', requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;

    // Build date filter
    const dateFilter = {};
    if (from || to) {
      dateFilter['metadata.fetchedAt'] = {};
      if (from) dateFilter['metadata.fetchedAt'].$gte = new Date(from);
      if (to) dateFilter['metadata.fetchedAt'].$lte = new Date(to);
    }

    // Get total news count
    const totalNews = await NewsEvent.countDocuments({ ...dateFilter, hidden: false });

    // Get news by source
    const newsBySource = await NewsEvent.aggregate([
      { $match: { ...dateFilter, hidden: false } },
      {
        $group: {
          _id: '$source',
          count: { $sum: 1 },
          avgConfidence: { $avg: '$confidence' }
        }
      },
      { $sort: { count: -1 } }
    ]);

    // Get news by category
    const newsByCategory = await NewsEvent.aggregate([
      { $match: { ...dateFilter, hidden: false } },
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    // Get recent news (last 24 hours)
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentNews = await NewsEvent.countDocuments({
      'metadata.fetchedAt': { $gte: last24Hours },
      hidden: false
    });

    // Get processing time statistics
    const processingStats = await NewsEvent.aggregate([
      { $match: { ...dateFilter, hidden: false, 'metadata.processingTime': { $exists: true } } },
      {
        $group: {
          _id: null,
          avgProcessingTime: { $avg: '$metadata.processingTime' },
          minProcessingTime: { $min: '$metadata.processingTime' },
          maxProcessingTime: { $max: '$metadata.processingTime' }
        }
      }
    ]);

    // Get latest news
    const latestNews = await NewsEvent.find({ ...dateFilter, hidden: false })
      .sort({ 'metadata.fetchedAt': -1 })
      .limit(5)
      .select('title source category date metadata.fetchedAt confidence');

    // Get average confidence
    const avgConfidence = await NewsEvent.aggregate([
      { $match: { ...dateFilter, hidden: false } },
      {
        $group: {
          _id: null,
          avgConfidence: { $avg: '$confidence' }
        }
      }
    ]);

    // Get news count over time (by day for last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const newsOverTime = await NewsEvent.aggregate([
      {
        $match: {
          'metadata.fetchedAt': { $gte: thirtyDaysAgo },
          hidden: false
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$metadata.fetchedAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Get top locations
    const topLocations = await NewsEvent.aggregate([
      { $match: { ...dateFilter, hidden: false, locationName: { $exists: true } } },
      {
        $group: {
          _id: '$locationName',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    const stats = {
      summary: {
        totalNews,
        recentNews24h: recentNews,
        avgConfidence: avgConfidence[0]?.avgConfidence || 0,
        dateRange: {
          from: from || 'all time',
          to: to || 'now'
        }
      },
      bySource: newsBySource.map(item => ({
        source: item._id,
        count: item.count,
        avgConfidence: item.avgConfidence
      })),
      byCategory: newsByCategory.map(item => ({
        category: item._id,
        count: item.count
      })),
      processing: {
        avgTimeMs: processingStats[0]?.avgProcessingTime || 0,
        minTimeMs: processingStats[0]?.minProcessingTime || 0,
        maxTimeMs: processingStats[0]?.maxProcessingTime || 0
      },
      topLocations: topLocations.map(item => ({
        location: item._id,
        count: item.count
      })),
      timeline: newsOverTime.map(item => ({
        date: item._id,
        count: item.count
      })),
      latestNews: latestNews.map(news => ({
        id: news._id,
        title: news.title,
        source: news.source,
        category: news.category,
        date: news.date,
        fetchedAt: news.metadata?.fetchedAt,
        confidence: news.confidence
      }))
    };

    res.json(stats);
  } catch (error) {
    logger.error('Error getting news stats:', error);
    res.status(500).json({
      error: 'Error getting news statistics',
      details: error.message
    });
  }
});

/**
 * GET /admin/forum/settings
 * Obtener configuración del foro
 */
router.get('/forum/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await ForumSettings.getSettings();
    res.json({ success: true, settings });
  } catch (error) {
    logger.error('Error getting forum settings:', error);
    res.status(500).json({
      error: 'Error al obtener configuración del foro',
      details: error.message
    });
  }
});

/**
 * PUT /admin/forum/settings
 * Actualizar configuración del foro
 */
router.put('/forum/settings', requireAdmin, async (req, res) => {
  try {
    const {
      postCooldownMinutes,
      maxCommentsPerDay,
      allowImages,
      allowLinks,
      maxThreadTitleLength,
      maxThreadContentLength,
      maxCommentLength,
      maxImagesPerPost
    } = req.body;

    const updates = {};
    if (postCooldownMinutes !== undefined) updates.postCooldownMinutes = postCooldownMinutes;
    if (maxCommentsPerDay !== undefined) updates.maxCommentsPerDay = maxCommentsPerDay;
    if (allowImages !== undefined) updates.allowImages = allowImages;
    if (allowLinks !== undefined) updates.allowLinks = allowLinks;
    if (maxThreadTitleLength !== undefined) updates.maxThreadTitleLength = maxThreadTitleLength;
    if (maxThreadContentLength !== undefined) updates.maxThreadContentLength = maxThreadContentLength;
    if (maxCommentLength !== undefined) updates.maxCommentLength = maxCommentLength;
    if (maxImagesPerPost !== undefined) updates.maxImagesPerPost = maxImagesPerPost;

    const settings = await ForumSettings.updateSettings(updates);

    logger.info('Forum settings updated by admin:', { admin: req.user.email, updates });

    res.json({
      success: true,
      settings,
      message: 'Configuración del foro actualizada correctamente'
    });
  } catch (error) {
    logger.error('Error updating forum settings:', error);
    res.status(500).json({
      error: 'Error al actualizar configuración del foro',
      details: error.message
    });
  }
});

/**
 * GET /admin/forum/stats
 * Obtener estadísticas del foro
 */
router.get('/forum/stats', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const lastMonth = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Estadísticas básicas
    const [
      totalThreads,
      totalComments,
      threadsToday,
      threadsThisWeek,
      threadsThisMonth,
      commentsToday,
      commentsThisWeek,
      commentsThisMonth,
      activeThreads,
      deletedThreads,
      totalLikes
    ] = await Promise.all([
      ForumThread.countDocuments(),
      ForumComment.countDocuments(),
      ForumThread.countDocuments({ createdAt: { $gte: yesterday } }),
      ForumThread.countDocuments({ createdAt: { $gte: lastWeek } }),
      ForumThread.countDocuments({ createdAt: { $gte: lastMonth } }),
      ForumComment.countDocuments({ createdAt: { $gte: yesterday } }),
      ForumComment.countDocuments({ createdAt: { $gte: lastWeek } }),
      ForumComment.countDocuments({ createdAt: { $gte: lastMonth } }),
      ForumThread.countDocuments({ status: 'active' }),
      ForumThread.countDocuments({ status: 'deleted' }),
      ForumThread.aggregate([
        { $group: { _id: null, totalLikes: { $sum: '$likesCount' } } }
      ])
    ]);

    // Threads más populares
    const popularThreads = await ForumThread.find({ status: 'active' })
      .sort({ likesCount: -1, commentsCount: -1 })
      .limit(5)
      .populate('author', 'email name')
      .select('title likesCount commentsCount createdAt author')
      .lean();

    // Threads más recientes
    const recentThreads = await ForumThread.find({ status: 'active' })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate('author', 'email name')
      .select('title likesCount commentsCount createdAt author')
      .lean();

    // Usuarios más activos (por threads creados)
    const topThreadAuthors = await ForumThread.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: '$author', threadCount: { $sum: 1 } } },
      { $sort: { threadCount: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      {
        $project: {
          userId: '$_id',
          name: { $ifNull: ['$user.name', '$user.email'] },
          email: '$user.email',
          threadCount: 1
        }
      }
    ]);

    // Usuarios más activos (por comentarios)
    const topCommentAuthors = await ForumComment.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: '$author', commentCount: { $sum: 1 } } },
      { $sort: { commentCount: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      {
        $project: {
          userId: '$_id',
          name: { $ifNull: ['$user.name', '$user.email'] },
          email: '$user.email',
          commentCount: 1
        }
      }
    ]);

    // Actividad por día (últimos 7 días)
    const activityByDay = await Promise.all(
      Array.from({ length: 7 }, async (_, i) => {
        const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        date.setHours(0, 0, 0, 0);
        const nextDate = new Date(date.getTime() + 24 * 60 * 60 * 1000);

        const [threads, comments] = await Promise.all([
          ForumThread.countDocuments({
            createdAt: { $gte: date, $lt: nextDate }
          }),
          ForumComment.countDocuments({
            createdAt: { $gte: date, $lt: nextDate }
          })
        ]);

        return {
          date: date.toISOString().split('T')[0],
          threads,
          comments,
          total: threads + comments
        };
      })
    );

    res.json({
      success: true,
      stats: {
        overview: {
          totalThreads,
          totalComments,
          totalPosts: totalThreads + totalComments,
          activeThreads,
          deletedThreads,
          totalLikes: totalLikes[0]?.totalLikes || 0
        },
        today: {
          threads: threadsToday,
          comments: commentsToday,
          total: threadsToday + commentsToday
        },
        thisWeek: {
          threads: threadsThisWeek,
          comments: commentsThisWeek,
          total: threadsThisWeek + commentsThisWeek
        },
        thisMonth: {
          threads: threadsThisMonth,
          comments: commentsThisMonth,
          total: threadsThisMonth + commentsThisMonth
        },
        popularThreads,
        recentThreads,
        topThreadAuthors,
        topCommentAuthors,
        activityByDay: activityByDay.reverse()
      }
    });
  } catch (error) {
    logger.error('Error getting forum stats:', error);
    res.status(500).json({
      error: 'Error al obtener estadísticas del foro',
      details: error.message
    });
  }
});

/**
 * GET /admin/pricing/settings
 * Get pricing configuration
 */
router.get('/pricing/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await PricingSettings.getSettings();
    res.json({ success: true, settings });
  } catch (error) {
    logger.error('Error getting pricing settings:', error);
    res.status(500).json({
      error: 'Error al obtener configuración de precios',
      details: error.message
    });
  }
});

/**
 * PUT /admin/pricing/settings
 * Update pricing configuration
 */
router.put('/pricing/settings', requireAdmin, async (req, res) => {
  try {
    const {
      usdToUyu,
      premiumMonthly,
      premiumYearly,
      proMonthly,
      proYearly
    } = req.body;

    const updates = {};
    if (usdToUyu !== undefined) updates.usdToUyu = Number(usdToUyu);
    if (premiumMonthly !== undefined) updates.premiumMonthly = Number(premiumMonthly);
    if (premiumYearly !== undefined) updates.premiumYearly = Number(premiumYearly);
    if (proMonthly !== undefined) updates.proMonthly = Number(proMonthly);
    if (proYearly !== undefined) updates.proYearly = Number(proYearly);

    const settings = await PricingSettings.updateSettings(updates);

    logger.info('Pricing settings updated by admin:', { admin: req.user.email, updates });

    res.json({
      success: true,
      message: 'Configuración de precios actualizada',
      settings
    });
  } catch (error) {
    logger.error('Error updating pricing settings:', error);
    res.status(500).json({
      error: 'Error al actualizar configuración de precios',
      details: error.message
    });
  }
});

/**
 * GET /admin/visits/stats
 * Get page visit statistics
 */
router.get('/visits/stats', requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;

    // Get overall stats
    const overallStats = await PageVisit.getOverallStats(from, to);

    // Get visits by day (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const visitsByDay = await PageVisit.aggregate([
      {
        $match: {
          timestamp: { $gte: from ? new Date(from) : thirtyDaysAgo }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$timestamp' }
          },
          total: { $sum: 1 },
          authenticated: {
            $sum: {
              $cond: [{ $ne: ['$userId', null] }, 1, 0]
            }
          },
          anonymous: {
            $sum: {
              $cond: [{ $eq: ['$userId', null] }, 1, 0]
            }
          }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Get visits by hour (today)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const visitsByHour = await PageVisit.aggregate([
      {
        $match: {
          timestamp: { $gte: todayStart }
        }
      },
      {
        $group: {
          _id: { $hour: '$timestamp' },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Get today's stats
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const todayVisits = await PageVisit.countDocuments({
      timestamp: { $gte: yesterday }
    });

    const todayStats = await PageVisit.getOverallStats(yesterday, new Date());

    res.json({
      success: true,
      overall: overallStats,
      today: {
        total: todayVisits,
        ...todayStats
      },
      timeline: visitsByDay.map(item => ({
        date: item._id,
        total: item.total,
        authenticated: item.authenticated,
        anonymous: item.anonymous
      })),
      hourly: visitsByHour.map(item => ({
        hour: item._id,
        count: item.count
      }))
    });
  } catch (error) {
    logger.error('Error getting visit stats:', error);
    res.status(500).json({
      error: 'Error al obtener estadísticas de visitas',
      details: error.message
    });
  }
});

/**
 * GET /admin/visits/recent
 * Get recent page visits
 */
router.get('/visits/recent', requireAdmin, async (req, res) => {
  try {
    const { limit = 100, page } = req.query;

    // Filter by specific page if provided
    const filter = page ? { page } : {};

    const recentVisits = await PageVisit.find(filter)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .populate('userId', 'email name')
      .select('page userId userEmail ipAddress timestamp userAgent');

    res.json({
      success: true,
      visits: recentVisits.map(visit => ({
        page: visit.page,
        user: visit.userId ? {
          id: visit.userId._id,
          email: visit.userId.email || visit.userEmail,
          name: visit.userId.name
        } : null,
        ipAddress: visit.userId ? null : visit.ipAddress, // Only show IP for anonymous users
        timestamp: visit.timestamp,
        userAgent: visit.userAgent
      })),
      total: recentVisits.length
    });
  } catch (error) {
    logger.error('Error getting recent visits:', error);
    res.status(500).json({
      error: 'Error al obtener visitas recientes',
      details: error.message
    });
  }
});

/**
 * DELETE /admin/visits/purge
 * Delete recent or all visits
 */
router.delete('/visits/purge', requireAdmin, async (req, res) => {
  try {
    const { scope } = req.body || {};

    // Validate scope (string or number)
    if (scope !== 'all' && scope !== 50 && scope !== '50') {
      return res.status(400).json({ error: 'Parámetro scope inválido. Usa "all" o 50.' });
    }

    let deletedCount = 0;

    if (scope === 'all') {
      const result = await PageVisit.deleteMany({});
      deletedCount = result.deletedCount || 0;
    } else if (scope === 50 || scope === '50') {
      const visits = await PageVisit.find({}).sort({ timestamp: -1 }).limit(50).select('_id');
      if (visits.length > 0) {
        const ids = visits.map(v => v._id);
        const result = await PageVisit.deleteMany({ _id: { $in: ids } });
        deletedCount = result.deletedCount || 0;
      }
    }

    logger.warn('Admin purged page visits', {
      scope,
      deletedCount,
      requestedBy: req.user?.uid || req.user?.email
    });

    res.json({
      message: `Se eliminaron ${deletedCount} visitas`,
      deleted: deletedCount
    });
  } catch (error) {
    logger.error('Error purging page visits:', error);
    res.status(500).json({ error: 'Error al eliminar visitas' });
  }
});

/**
 * GET /admin/system/maintenance-status (PUBLIC)
 * Get current maintenance status for all platforms
 */
router.get('/system/maintenance-status', getMaintenanceStatus);

/**
 * GET /admin/system/settings
 * Get system settings including maintenance modes
 */
router.get('/system/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await SystemSettings.getSettings();
    res.json({ success: true, settings });
  } catch (error) {
    logger.error('Error getting system settings:', error);
    res.status(500).json({
      error: 'Error al obtener configuración del sistema',
      details: error.message
    });
  }
});

/**
 * PUT /admin/system/settings
 * Update system settings including maintenance modes
 */
router.put('/system/settings', requireAdmin, async (req, res) => {
  try {
    const { maintenanceMode, maintenanceMessages } = req.body;

    const updates = {};
    if (maintenanceMode !== undefined) updates.maintenanceMode = maintenanceMode;
    if (maintenanceMessages !== undefined) updates.maintenanceMessages = maintenanceMessages;

    const settings = await SystemSettings.updateSettings(
      updates,
      req.user.email || req.user.uid
    );

    logger.info('System settings updated by admin:', {
      admin: req.user.email,
      updates
    });

    res.json({
      success: true,
      settings,
      message: 'Configuración del sistema actualizada correctamente'
    });
  } catch (error) {
    logger.error('Error updating system settings:', error);
    res.status(500).json({
      error: 'Error al actualizar configuración del sistema',
      details: error.message
    });
  }
});

/**
 * POST /admin/maintenance/run-cleanup
 * Manually trigger the scheduled cleanup sequence
 */
router.post('/maintenance/run-cleanup', requireAdmin, async (req, res) => {
  try {
    logger.info('Manual scheduled cleanup requested', {
      requestedBy: req.user.uid
    });

    const summary = await runScheduledCleanup();

    res.json({
      message: 'Limpieza programada ejecutada correctamente',
      summary
    });
  } catch (error) {
    logger.error('Error running manual scheduled cleanup', { error: error.message });
    res.status(500).json({
      error: 'No se pudo ejecutar la limpieza programada',
      details: error.message
    });
  }
});

/**
 * GET /admin/visits/pages
 * Get visit statistics grouped by page
 */
router.get('/visits/pages', requireAdmin, async (req, res) => {
  try {
    const { from, to, limit = 20 } = req.query;

    const query = {};
    if (from || to) {
      query.timestamp = {};
      if (from) query.timestamp.$gte = new Date(from);
      if (to) query.timestamp.$lte = new Date(to);
    }

    const pageStats = await PageVisit.aggregate([
      { $match: query },
      {
        $group: {
          _id: '$page',
          total: { $sum: 1 },
          authenticated: {
            $sum: {
              $cond: [{ $ne: ['$userId', null] }, 1, 0]
            }
          },
          anonymous: {
            $sum: {
              $cond: [{ $eq: ['$userId', null] }, 1, 0]
            }
          },
          uniqueUsers: { $addToSet: '$userId' },
          uniqueIPs: { $addToSet: '$ipAddress' }
        }
      },
      {
        $project: {
          page: '$_id',
          total: 1,
          authenticated: 1,
          anonymous: 1,
          uniqueAuthUsers: { $size: { $filter: { input: '$uniqueUsers', cond: { $ne: ['$$this', null] } } } },
          uniqueAnonIPs: { $size: { $filter: { input: '$uniqueIPs', cond: { $ne: ['$$this', null] } } } }
        }
      },
      { $sort: { total: -1 } },
      { $limit: parseInt(limit) }
    ]);

    res.json({
      success: true,
      pages: pageStats.map(stat => ({
        page: stat.page,
        total: stat.total,
        authenticated: stat.authenticated,
        anonymous: stat.anonymous,
        uniqueUsers: stat.uniqueAuthUsers + stat.uniqueAnonIPs
      }))
    });
  } catch (error) {
    logger.error('Error getting page visit stats:', error);
    res.status(500).json({
      error: 'Error al obtener estadísticas por página',
      details: error.message
    });
  }
});

/**
 * GET /admin/cron/settings
 * Get current cron job settings
 */
router.get('/cron/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await SystemSettings.getSettings();

    res.json({
      success: true,
      cronSchedules: settings.cronSchedules,
      cronEnabled: settings.cronEnabled
    });
  } catch (error) {
    logger.error('Error getting cron settings:', error);
    res.status(500).json({
      error: 'Error al obtener configuración de cron jobs',
      details: error.message
    });
  }
});

/**
 * PUT /admin/cron/settings
 * Update cron job settings
 */
router.put('/cron/settings', requireAdmin, async (req, res) => {
  try {
    const { cronSchedules, cronEnabled } = req.body;

    // Validate cron expressions
    if (cronSchedules) {
      const cron = await import('node-cron');
      for (const [job, schedule] of Object.entries(cronSchedules)) {
        if (!cron.validate(schedule)) {
          return res.status(400).json({
            error: `Expresión cron inválida para ${job}: ${schedule}`,
            details: 'Formato: * * * * * (minuto hora día mes día-de-semana)'
          });
        }
      }
    }

    // Update settings
    const settings = await SystemSettings.updateSettings(
      { cronSchedules, cronEnabled },
      req.user.email || req.user.uid
    );

    logger.info('Cron settings updated', {
      updatedBy: req.user.email || req.user.uid,
      cronSchedules,
      cronEnabled
    });

    // Reload cron jobs with new configuration
    // Note: io needs to be passed from app.js
    if (req.app.get('io')) {
      await reloadCronJobs(req.app.get('io'));
      logger.info('Cron jobs reloaded with new configuration');
    }

    res.json({
      success: true,
      message: 'Configuración de cron jobs actualizada exitosamente',
      cronSchedules: settings.cronSchedules,
      cronEnabled: settings.cronEnabled
    });
  } catch (error) {
    logger.error('Error updating cron settings:', error);
    res.status(500).json({
      error: 'Error al actualizar configuración de cron jobs',
      details: error.message
    });
  }
});

/**
 * POST /admin/cron/:job/run
 * Manually trigger a cron job
 */
router.post('/cron/:job/run', requireAdmin, async (req, res) => {
  try {
    const { job } = req.params;

    logger.info(`Manually triggering cron job: ${job}`, {
      triggeredBy: req.user.email || req.user.uid
    });

    let result;

    switch (job) {
      case 'newsIngestion':
        result = await runNewsIngestion(req.app.get('io'));
        break;
      case 'cleanup':
        result = await runScheduledCleanup();
        break;
      default:
        return res.status(400).json({
          error: 'Trabajo cron no válido',
          validJobs: ['newsIngestion', 'cleanup']
        });
    }

    res.json({
      success: true,
      message: `Trabajo ${job} ejecutado exitosamente`,
      result
    });
  } catch (error) {
    logger.error(`Error running cron job manually: ${req.params.job}`, error);
    res.status(500).json({
      error: `Error al ejecutar trabajo ${req.params.job}`,
      details: error.message
    });
  }
});

// ============================================================================
// API TOKENS MANAGEMENT
// ============================================================================

/**
 * GET /admin/api-tokens
 * List all API tokens
 */
router.get('/api-tokens', requireAdmin, async (req, res) => {
  try {
    const tokens = await ApiToken.find()
      .sort({ createdAt: -1 })
      .lean();

    // Populate user info
    const tokensWithUsers = await Promise.all(tokens.map(async (token) => {
      const user = await User.findOne({ uid: token.userId }).select('name email picture').lean();
      return {
        ...token,
        user
      };
    }));

    res.json({
      success: true,
      tokens: tokensWithUsers
    });
  } catch (error) {
    logger.error('Error fetching API tokens:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener tokens API'
    });
  }
});

/**
 * POST /admin/api-tokens
 * Generate a new API token
 */
router.post('/api-tokens', requireAdmin, async (req, res) => {
  try {
    const { name, description, permissions, tokenBytes, expiresInDays } = req.body;

    // Validation
    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'El nombre del token es requerido'
      });
    }

    // Calculate expiration if provided
    let expiresAt = null;
    if (expiresInDays && expiresInDays > 0) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + parseInt(expiresInDays));
    }

    // Create token
    const token = await ApiToken.createToken({
      userId: req.user.uid,
      name: name.trim(),
      description: description?.trim() || '',
      permissions: permissions || ['all'],
      tokenBytes: tokenBytes || 32,
      expiresAt
    });

    logger.info(`API Token created: ${name} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Token API creado exitosamente',
      token: {
        _id: token._id,
        token: token.token, // IMPORTANT: Only show the actual token on creation!
        name: token.name,
        description: token.description,
        permissions: token.permissions,
        createdAt: token.createdAt,
        expiresAt: token.expiresAt
      }
    });
  } catch (error) {
    logger.error('Error creating API token:', error);
    res.status(500).json({
      success: false,
      error: 'Error al crear token API',
      details: error.message
    });
  }
});

/**
 * DELETE /admin/api-tokens/:id
 * Revoke/delete an API token
 */
router.delete('/api-tokens/:id', requireAdmin, async (req, res) => {
  try {
    const token = await ApiToken.findById(req.params.id);

    if (!token) {
      return res.status(404).json({
        success: false,
        error: 'Token no encontrado'
      });
    }

    // Revoke the token
    await token.revoke(req.user.uid);

    logger.info(`API Token revoked: ${token.name} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Token API revocado exitosamente'
    });
  } catch (error) {
    logger.error('Error revoking API token:', error);
    res.status(500).json({
      success: false,
      error: 'Error al revocar token API',
      details: error.message
    });
  }
});

/**
 * PUT /admin/api-tokens/:id
 * Update API token (name, description, permissions, expiration)
 */
router.put('/api-tokens/:id', requireAdmin, async (req, res) => {
  try {
    const { name, description, permissions, expiresInDays } = req.body;

    const token = await ApiToken.findById(req.params.id);

    if (!token) {
      return res.status(404).json({
        success: false,
        error: 'Token no encontrado'
      });
    }

    if (token.isRevoked) {
      return res.status(400).json({
        success: false,
        error: 'No se puede actualizar un token revocado'
      });
    }

    // Update fields
    if (name) token.name = name.trim();
    if (description !== undefined) token.description = description.trim();
    if (permissions) token.permissions = permissions;

    if (expiresInDays !== undefined) {
      if (expiresInDays === null || expiresInDays === 0) {
        token.expiresAt = null;
      } else {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + parseInt(expiresInDays));
        token.expiresAt = expiresAt;
      }
    }

    await token.save();

    logger.info(`API Token updated: ${token.name} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Token API actualizado exitosamente',
      token
    });
  } catch (error) {
    logger.error('Error updating API token:', error);
    res.status(500).json({
      success: false,
      error: 'Error al actualizar token API',
      details: error.message
    });
  }
});

// ============================================================================
// DONORS MANAGEMENT
// ============================================================================

/**
 * GET /admin/donors
 * Get all donors
 */
router.get('/donors', requireAdmin, async (req, res) => {
  try {
    const donors = await Donor.getAllDonors();

    res.json({
      success: true,
      donors
    });
  } catch (error) {
    logger.error('Error fetching donors:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener donadores',
      details: error.message
    });
  }
});

/**
 * GET /admin/donors/:id
 * Get a specific donor
 */
router.get('/donors/:id', requireAdmin, async (req, res) => {
  try {
    const donor = await Donor.findById(req.params.id);

    if (!donor) {
      return res.status(404).json({
        success: false,
        error: 'Donador no encontrado'
      });
    }

    res.json({
      success: true,
      donor
    });
  } catch (error) {
    logger.error('Error fetching donor:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener donador',
      details: error.message
    });
  }
});

/**
 * POST /admin/donors
 * Create a new donor
 */
router.post('/donors', requireAdmin, async (req, res) => {
  try {
    const { name, amount, currency, date, message, isAnonymous } = req.body;

    // Validation
    if (!name || !amount || !date) {
      return res.status(400).json({
        success: false,
        error: 'Nombre, monto y fecha son requeridos'
      });
    }

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'El monto debe ser mayor a 0'
      });
    }

    // Create donor
    const donor = new Donor({
      name: name.trim(),
      amount: parseFloat(amount),
      currency: currency || 'USD',
      date: date.trim(),
      message: message?.trim() || '',
      isAnonymous: !!isAnonymous
    });

    await donor.save();

    logger.info(`Donor created: ${name} - $${amount} by ${req.user.email}`);

    res.status(201).json({
      success: true,
      message: 'Donador creado exitosamente',
      donor
    });
  } catch (error) {
    logger.error('Error creating donor:', error);
    res.status(500).json({
      success: false,
      error: 'Error al crear donador',
      details: error.message
    });
  }
});

/**
 * PUT /admin/donors/:id
 * Update a donor
 */
router.put('/donors/:id', requireAdmin, async (req, res) => {
  try {
    const { name, amount, currency, date, message, isAnonymous } = req.body;

    const donor = await Donor.findById(req.params.id);

    if (!donor) {
      return res.status(404).json({
        success: false,
        error: 'Donador no encontrado'
      });
    }

    // Update fields
    if (name !== undefined) donor.name = name.trim();
    if (amount !== undefined) {
      if (amount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'El monto debe ser mayor a 0'
        });
      }
      donor.amount = parseFloat(amount);
    }
    if (currency !== undefined) donor.currency = currency;
    if (date !== undefined) donor.date = date.trim();
    if (message !== undefined) donor.message = message.trim();
    if (isAnonymous !== undefined) donor.isAnonymous = !!isAnonymous;

    await donor.save();

    logger.info(`Donor updated: ${donor.name} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Donador actualizado exitosamente',
      donor
    });
  } catch (error) {
    logger.error('Error updating donor:', error);
    res.status(500).json({
      success: false,
      error: 'Error al actualizar donador',
      details: error.message
    });
  }
});

/**
 * DELETE /admin/donors/:id
 * Delete a donor
 */
router.delete('/donors/:id', requireAdmin, async (req, res) => {
  try {
    const donor = await Donor.findByIdAndDelete(req.params.id);

    if (!donor) {
      return res.status(404).json({
        success: false,
        error: 'Donador no encontrado'
      });
    }

    logger.info(`Donor deleted: ${donor.name} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Donador eliminado exitosamente'
    });
  } catch (error) {
    logger.error('Error deleting donor:', error);
    res.status(500).json({
      success: false,
      error: 'Error al eliminar donador',
      details: error.message
    });
  }
});

/**
 * GET /admin/news/search
 * Search news by query
 */
router.get('/news/search', requireAdmin, async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.json({
        success: true,
        news: []
      });
    }

    const query = {
      $or: [
        { title: { $regex: q, $options: 'i' } },
        { content: { $regex: q, $options: 'i' } },
        { source: { $regex: q, $options: 'i' } }
      ]
    };

    const news = await NewsEvent.find(query)
      .select('_id title source url publishedAt')
      .sort({ publishedAt: -1 })
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      news: news.map(n => ({
        _id: n._id,
        title: n.title,
        source: n.source,
        url: n.url,
        publishedAt: n.publishedAt
      }))
    });
  } catch (error) {
    logger.error('Error searching news:', error);
    res.status(500).json({
      success: false,
      error: 'Error al buscar noticias',
      details: error.message
    });
  }
});

export default router;
