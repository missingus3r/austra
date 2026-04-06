import logger from '../utils/logger.js';

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast?latitude=-34.9011&longitude=-56.1645&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,precipitation,apparent_temperature&hourly=temperature_2m,precipitation_probability,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,weather_code&timezone=America/Montevideo&forecast_days=3';

// In-memory cache (30 minutes TTL)
let cache = {
  data: null,
  timestamp: 0
};

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes in milliseconds

/**
 * WMO Weather Code to Spanish description mapping
 * @see https://www.nodc.noaa.gov/archive/arc0021/0002199/1.1/data/0-data/HTML/WMO-CODE/WMO4677.HTM
 */
const WMO_CODES = {
  0: 'Despejado',
  1: 'Mayormente despejado',
  2: 'Parcialmente nublado',
  3: 'Nublado',
  45: 'Niebla',
  48: 'Niebla con escarcha',
  51: 'Llovizna ligera',
  53: 'Llovizna moderada',
  55: 'Llovizna intensa',
  56: 'Llovizna helada ligera',
  57: 'Llovizna helada intensa',
  61: 'Lluvia ligera',
  63: 'Lluvia moderada',
  65: 'Lluvia intensa',
  66: 'Lluvia helada ligera',
  67: 'Lluvia helada intensa',
  71: 'Nevada ligera',
  73: 'Nevada moderada',
  75: 'Nevada intensa',
  77: 'Granizo fino',
  80: 'Chubascos ligeros',
  81: 'Chubascos moderados',
  82: 'Chubascos intensos',
  85: 'Chubascos de nieve ligeros',
  86: 'Chubascos de nieve intensos',
  95: 'Tormenta eléctrica',
  96: 'Tormenta con granizo ligero',
  99: 'Tormenta con granizo intenso'
};

/**
 * Convert WMO weather code to Spanish description
 * @param {number} code - WMO weather code
 * @returns {string} Spanish weather description
 */
export function getWeatherDescription(code) {
  return WMO_CODES[code] || 'Desconocido';
}

/**
 * Parse raw Open-Meteo response into structured weather data
 * @param {Object} raw - Raw API response
 * @returns {Object} Parsed weather data
 */
function parseWeatherData(raw) {
  const current = {
    temperature: raw.current.temperature_2m,
    feels_like: raw.current.apparent_temperature,
    humidity: raw.current.relative_humidity_2m,
    wind: raw.current.wind_speed_10m,
    precipitation: raw.current.precipitation,
    weather_code: raw.current.weather_code,
    description: getWeatherDescription(raw.current.weather_code),
    time: raw.current.time
  };

  const forecast = raw.daily.time.map((date, i) => ({
    date,
    temp_max: raw.daily.temperature_2m_max[i],
    temp_min: raw.daily.temperature_2m_min[i],
    precipitation_sum: raw.daily.precipitation_sum[i],
    precipitation_probability: raw.daily.precipitation_probability_max[i],
    weather_code: raw.daily.weather_code[i],
    description: getWeatherDescription(raw.daily.weather_code[i])
  }));

  return {
    current,
    forecast,
    units: {
      temperature: raw.current_units?.temperature_2m || '°C',
      wind: raw.current_units?.wind_speed_10m || 'km/h',
      precipitation: raw.current_units?.precipitation || 'mm',
      humidity: raw.current_units?.relative_humidity_2m || '%'
    },
    location: {
      latitude: raw.latitude,
      longitude: raw.longitude,
      timezone: raw.timezone
    },
    cached: false,
    fetched_at: new Date().toISOString()
  };
}

/**
 * Fetch weather data from Open-Meteo API
 * Results are cached for 30 minutes
 * @returns {Promise<Object>} Parsed weather data
 */
export async function getWeather() {
  // Check cache
  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    logger.info('Returning cached weather data');
    return { ...cache.data, cached: true };
  }

  logger.info('Fetching weather data from Open-Meteo...');

  try {
    const response = await fetch(OPEN_METEO_URL, {
      signal: AbortSignal.timeout(10000) // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(`Open-Meteo API returned status ${response.status}`);
    }

    const raw = await response.json();
    const parsed = parseWeatherData(raw);

    // Update cache
    cache = {
      data: parsed,
      timestamp: now
    };

    logger.info('Successfully fetched and cached weather data');
    return parsed;

  } catch (error) {
    logger.error('Error fetching weather data:', error);

    // Return stale cache if available
    if (cache.data) {
      logger.warn('Returning stale cached weather data due to fetch error');
      return { ...cache.data, cached: true, stale: true };
    }

    throw error;
  }
}
