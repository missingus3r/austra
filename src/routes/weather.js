import express from 'express';
import { getWeather } from '../services/weatherService.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * @route GET /weather
 * @desc Get current weather + 3-day forecast
 * @access Public
 */
router.get('/', async (req, res) => {
  try {
    const weather = await getWeather();

    res.json({
      success: true,
      data: weather
    });
  } catch (error) {
    logger.error('Error fetching weather:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener el clima'
    });
  }
});

/**
 * @route GET /weather/current
 * @desc Get only current weather conditions
 * @access Public
 */
router.get('/current', async (req, res) => {
  try {
    const weather = await getWeather();

    res.json({
      success: true,
      data: {
        ...weather.current,
        units: weather.units,
        location: weather.location,
        cached: weather.cached,
        fetched_at: weather.fetched_at
      }
    });
  } catch (error) {
    logger.error('Error fetching current weather:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener el clima actual'
    });
  }
});

export default router;
