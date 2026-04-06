import cron from 'node-cron';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { runNewsIngestion } from './newsIngestion.js';
import { runExchangeSync } from './exchangeSync.js';
import { runBitcoinSync } from './bitcoinSync.js';
import logger from '../utils/logger.js';
import {
  Validation,
  Notification,
  ForumThread,
  ForumComment,
  User,
  SystemSettings
} from '../models/index.js';
import mongoose from 'mongoose';

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const VALIDATION_ARCHIVE_DAYS = 180;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, '../../uploads');

// Lightweight archive collection for validations. We only care about storing the originals.
const validationArchiveCollection = () => mongoose.connection.collection('validationarchives');

/**
 * Move old validations to an archive collection to keep the primary collection small.
 */
async function archiveOldValidations() {
  const cutoff = new Date(Date.now() - VALIDATION_ARCHIVE_DAYS * DAY_IN_MS);

  const oldValidations = await Validation.find({
    createdAt: { $lt: cutoff }
  }).limit(2000).lean(); // safeguard: archive in batches if the dataset is huge

  if (oldValidations.length === 0) {
    return { archived: 0 };
  }

  const archiveOps = [];
  const archivedAt = new Date();
  for (const doc of oldValidations) {
    const { _id, ...rest } = doc;
    archiveOps.push({
      updateOne: {
        filter: { originalId: _id },
        update: {
          $setOnInsert: {
            ...rest,
            originalId: _id,
            archivedAt
          }
        },
        upsert: true
      }
    });
  }

  let archiveCollection;
  try {
    archiveCollection = validationArchiveCollection();
  } catch (error) {
    logger.warn('Validation archive collection unavailable, skipping archival', {
      error: error.message
    });
    return { archived: 0 };
  }

  if (archiveOps.length > 0) {
    try {
      await archiveCollection.bulkWrite(archiveOps, { ordered: false });
    } catch (error) {
      logger.error('Failed to archive validations', { error: error.message });
      throw error;
    }
  }

  const idsToRemove = oldValidations.map(doc => doc._id);
  const deleteResult = await Validation.deleteMany({ _id: { $in: idsToRemove } });

  logger.info('Archived old validations', {
    archived: deleteResult.deletedCount || 0
  });

  return { archived: deleteResult.deletedCount || 0 };
}

/**
 * Delete files from /uploads that are no longer referenced by any entity.
 */
async function removeOrphanedMediaFiles() {
  let filesInUploads = [];
  try {
    filesInUploads = await fs.readdir(uploadsDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { deleted: 0 }; // nothing to clean
    }
    throw error;
  }

  if (filesInUploads.length === 0) {
    return { deleted: 0 };
  }

  const referencedFiles = new Set();

  const threads = await ForumThread.find({ 'images.0': { $exists: true } }).select('images').lean();
  for (const thread of threads) {
    for (const image of thread.images || []) {
      const filename = image?.filename || (image?.url ? path.basename(image.url.split('?')[0]) : null);
      if (filename) referencedFiles.add(filename);
    }
  }

  const comments = await ForumComment.find({ 'images.0': { $exists: true } }).select('images').lean();
  for (const comment of comments) {
    for (const image of comment.images || []) {
      const filename = image?.filename || (image?.url ? path.basename(image.url.split('?')[0]) : null);
      if (filename) referencedFiles.add(filename);
    }
  }

  let deleted = 0;
  for (const filename of filesInUploads) {
    if (referencedFiles.has(filename)) {
      continue;
    }
    try {
      await fs.unlink(path.join(uploadsDir, filename));
      deleted += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('Failed to delete orphaned media file', {
          filename,
          error: error.message
        });
      }
    }
  }

  if (deleted > 0) {
    logger.info('Removed orphaned media files', { deleted });
  }

  return { deleted };
}

/**
 * Run the full maintenance cleanup sequence. Errors in one phase do not stop later phases.
 */
export async function runScheduledCleanup() {
  const summary = {
    validationsArchived: 0,
    orphanedFilesDeleted: 0
  };

  try {
    const validationResult = await archiveOldValidations();
    summary.validationsArchived = validationResult.archived;
  } catch (error) {
    logger.error('Validation archival failed', { error: error.message });
  }

  try {
    const orphanResult = await removeOrphanedMediaFiles();
    summary.orphanedFilesDeleted = orphanResult.deleted;
  } catch (error) {
    logger.error('Orphaned media cleanup failed', { error: error.message });
  }

  logger.info('Scheduled maintenance cleanup completed', summary);
  return summary;
}

// Store active cron tasks for hot-reloading
let activeCronTasks = {
  newsIngestion: null,
  cleanup: null,
  bcuSync: null,
  bitcoinSync: null // Using setInterval instead of cron (every 15 seconds)
};

/**
 * Start or restart a specific cron job
 * @param {String} jobName - Name of the job
 * @param {String} schedule - Cron schedule expression
 * @param {Function} task - Task function to execute
 * @param {Boolean} enabled - Whether the job is enabled
 */
function scheduleCronJob(jobName, schedule, task, enabled = true) {
  // Stop existing task if any
  if (activeCronTasks[jobName]) {
    activeCronTasks[jobName].stop();
    activeCronTasks[jobName] = null;
    logger.info(`Stopped existing cron job: ${jobName}`);
  }

  // Only schedule if enabled
  if (enabled) {
    try {
      activeCronTasks[jobName] = cron.schedule(schedule, task);
      logger.info(`Scheduled cron job: ${jobName} with schedule: ${schedule}`);
    } catch (error) {
      logger.error(`Failed to schedule cron job: ${jobName}`, { error: error.message });
    }
  } else {
    logger.info(`Cron job ${jobName} is disabled`);
  }
}

/**
 * Load cron configuration from database and start jobs
 * @param {SocketIO.Server} io - Socket.IO instance
 */
export async function startCronJobs(io) {
  logger.info('Starting cron jobs with dynamic configuration');

  try {
    const settings = await SystemSettings.getSettings();

    // News ingestion job
    scheduleCronJob(
      'newsIngestion',
      settings.cronSchedules.newsIngestion,
      async () => {
        logger.info('Running scheduled news ingestion');
        try {
          await runNewsIngestion(io);
        } catch (error) {
          logger.error('News ingestion cron failed:', error);
        }
      },
      settings.cronEnabled.newsIngestion
    );

    // Cleanup job
    scheduleCronJob(
      'cleanup',
      settings.cronSchedules.cleanup,
      async () => {
        logger.info('Running scheduled cleanup');
        try {
          await runScheduledCleanup();
        } catch (error) {
          logger.error('Cleanup cron failed:', error);
        }
      },
      settings.cronEnabled.cleanup
    );

    // Exchange rates sync job (BROU + DGI)
    scheduleCronJob(
      'exchangeSync',
      settings.cronSchedules.bcuSync,
      async () => {
        logger.info('Running scheduled exchange rates synchronization (BROU + DGI)');
        try {
          await runExchangeSync();
        } catch (error) {
          logger.error('Exchange rates sync cron failed:', error);
        }
      },
      settings.cronEnabled.bcuSync
    );

    // Bitcoin price sync job (every 15 seconds using setInterval)
    const bitcoinInterval = parseInt(process.env.BITCOIN_CACHE_DURATION) || 15000;

    // Stop existing interval if any
    if (activeCronTasks.bitcoinSync) {
      clearInterval(activeCronTasks.bitcoinSync);
      activeCronTasks.bitcoinSync = null;
      logger.info('Stopped existing Bitcoin sync interval');
    }

    // Start Bitcoin sync interval
    activeCronTasks.bitcoinSync = setInterval(async () => {
      try {
        await runBitcoinSync();
      } catch (error) {
        logger.error('Bitcoin sync interval failed:', error);
      }
    }, bitcoinInterval);

    logger.info(`Scheduled Bitcoin sync interval: every ${bitcoinInterval}ms (${bitcoinInterval/1000}s)`);

    // Run Bitcoin sync immediately on startup
    runBitcoinSync().catch(error => {
      logger.error('Initial Bitcoin sync failed:', error);
    });

    logger.info('All cron jobs started successfully');
  } catch (error) {
    logger.error('Failed to start cron jobs:', error);
    // Fallback to default schedules if database fails
    logger.warn('Falling back to default cron schedules');
    scheduleCronJob('newsIngestion', '*/15 * * * *', async () => {
      try {
        await runNewsIngestion(io);
      } catch (error) {
        logger.error('News ingestion cron failed:', error);
      }
    });
    scheduleCronJob('cleanup', '0 3 * * *', async () => {
      try {
        await runScheduledCleanup();
      } catch (error) {
        logger.error('Cleanup cron failed:', error);
      }
    });
    scheduleCronJob('bcuSync', '0 8 * * *', async () => {
      try {
        await runBcuSync();
      } catch (error) {
        logger.error('BCU sync cron failed:', error);
      }
    });

    // Bitcoin sync fallback (every 15 seconds)
    const bitcoinInterval = parseInt(process.env.BITCOIN_CACHE_DURATION) || 15000;
    if (activeCronTasks.bitcoinSync) {
      clearInterval(activeCronTasks.bitcoinSync);
    }
    activeCronTasks.bitcoinSync = setInterval(async () => {
      try {
        await runBitcoinSync();
      } catch (error) {
        logger.error('Bitcoin sync interval failed:', error);
      }
    }, bitcoinInterval);
    logger.info(`Fallback: Scheduled Bitcoin sync interval every ${bitcoinInterval}ms`);
    runBitcoinSync().catch(error => {
      logger.error('Initial Bitcoin sync failed:', error);
    });
  }
}

/**
 * Reload cron jobs with updated configuration
 * @param {SocketIO.Server} io - Socket.IO instance
 */
export async function reloadCronJobs(io) {
  logger.info('Reloading cron jobs with updated configuration');
  await startCronJobs(io);
}
