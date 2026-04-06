import axios from 'axios';
import * as cheerio from 'cheerio';
import { parseString } from 'xml2js';
import { promisify } from 'util';
import crypto from 'crypto';
import nlp from 'compromise';
import { NewsEvent } from '../models/index.js';
import logger from '../utils/logger.js';
import { emitNewsAdded } from '../sockets/eventHandlers.js';

/**
 * Simple geocode using Nominatim (previously in geoService.js)
 */
async function geocode(query) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Austra/1.0' },
      timeout: 5000
    });
    if (data && data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon),
        displayName: data[0].display_name,
        countryCode: data[0].address?.country_code || null
      };
    }
    return null;
  } catch (error) {
    logger.warn('Geocode failed', { query, error: error.message });
    return null;
  }
}

const parseXml = promisify(parseString);

// News source configurations
const NEWS_SOURCES = [
  {
    name: 'El Observador - Sociales',
    rssUrl: 'https://www.elobservador.com.uy/rss/pages/sociales.xml',
    type: 'rss'
  },
  {
    name: 'El Observador - Último Momento',
    rssUrl: 'https://www.elobservador.com.uy/rss/pages/ultimo-momento.xml',
    type: 'rss'
  },
  {
    name: 'El Observador - Home',
    rssUrl: 'https://www.elobservador.com.uy/rss/pages/home.xml',
    type: 'rss'
  },
  {
    name: 'Portal Montevideo',
    rssUrl: 'https://www.montevideo.com.uy/anxml.aspx?59',
    type: 'rss'
  },
  {
    name: 'Subrayado - Nacional',
    rssUrl: 'https://www.subrayado.com.uy/rss/pages/nacional.xml',
    type: 'rss'
  },
  {
    name: 'Subrayado - Policiales',
    rssUrl: 'https://www.subrayado.com.uy/rss/pages/policiales.xml',
    type: 'rss'
  }
];

// Category classification keywords
const CATEGORY_KEYWORDS = {
  homicidio: ['homicidio', 'asesinato', 'mató', 'muerto', 'fallecido', 'homicida'],
  rapiña: ['rapiña', 'asalto', 'atraco', 'robo violento', 'copamiento'],
  hurto: ['hurto', 'robo', 'sustracción', 'robaron'],
  copamiento: ['copamiento', 'secuestro', 'rehén', 'retén'],
  violencia_domestica: ['violencia doméstica', 'femicidio', 'violencia de género'],
  narcotrafico: ['narcotráfico', 'droga', 'cocaína', 'marihuana', 'pasta base']
};

/**
 * Classify article category based on content
 * @param {String} text - Article text
 * @returns {String} Category
 */
function classifyCategory(text) {
  const lowerText = text.toLowerCase();

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) {
        return category;
      }
    }
  }

  return 'otro';
}

/**
 * List of all countries (Spanish and English names)
 */
const COUNTRIES = [
  // América del Sur
  'argentina', 'bolivia', 'brasil', 'brazil', 'chile', 'colombia', 'ecuador',
  'guyana', 'paraguay', 'perú', 'peru', 'surinam', 'suriname', 'uruguay', 'venezuela',

  // América Central
  'belice', 'belize', 'costa rica', 'el salvador', 'guatemala', 'honduras',
  'nicaragua', 'panamá', 'panama',

  // América del Norte
  'canadá', 'canada', 'estados unidos', 'united states', 'usa', 'méxico', 'mexico',

  // Caribe
  'antigua', 'bahamas', 'barbados', 'cuba', 'dominica', 'granada', 'grenada',
  'haití', 'haiti', 'jamaica', 'república dominicana', 'dominican republic',
  'san cristóbal', 'santa lucía', 'saint lucia', 'trinidad', 'tobago',

  // Europa Occidental
  'alemania', 'germany', 'austria', 'bélgica', 'belgium', 'dinamarca', 'denmark',
  'españa', 'spain', 'finlandia', 'finland', 'francia', 'france', 'grecia', 'greece',
  'irlanda', 'ireland', 'islandia', 'iceland', 'italia', 'italy', 'luxemburgo',
  'noruega', 'norway', 'países bajos', 'netherlands', 'holanda', 'holland',
  'portugal', 'reino unido', 'united kingdom', 'inglaterra', 'england', 'escocia',
  'scotland', 'gales', 'wales', 'suecia', 'sweden', 'suiza', 'switzerland',

  // Europa Oriental
  'albania', 'bielorrusia', 'belarus', 'bosnia', 'herzegovina', 'bulgaria',
  'croacia', 'croatia', 'eslovaquia', 'slovakia', 'eslovenia', 'slovenia',
  'estonia', 'hungría', 'hungary', 'letonia', 'latvia', 'lituania', 'lithuania',
  'macedonia', 'moldavia', 'moldova', 'montenegro', 'polonia', 'poland',
  'república checa', 'czech republic', 'rumania', 'romania', 'rusia', 'russia',
  'serbia', 'ucrania', 'ukraine',

  // Medio Oriente
  'afganistán', 'afghanistan', 'arabia saudita', 'saudi arabia', 'baréin', 'bahrain',
  'catar', 'qatar', 'emiratos árabes', 'uae', 'irak', 'iraq', 'irán', 'iran',
  'israel', 'jordania', 'jordan', 'kuwait', 'líbano', 'lebanon', 'omán', 'oman',
  'pakistán', 'pakistan', 'siria', 'syria', 'turquía', 'turkey', 'yemen',

  // Asia
  'bangladesh', 'brunéi', 'brunei', 'camboya', 'cambodia', 'china', 'corea del norte',
  'north korea', 'corea del sur', 'south korea', 'corea', 'korea', 'filipinas',
  'philippines', 'india', 'indonesia', 'japón', 'japan', 'kazajistán', 'kazakhstan',
  'kirguistán', 'kyrgyzstan', 'laos', 'malasia', 'malaysia', 'maldivas', 'maldives',
  'mongolia', 'myanmar', 'nepal', 'singapur', 'singapore', 'sri lanka', 'tailandia',
  'thailand', 'taiwán', 'taiwan', 'tayikistán', 'tajikistan', 'turkmenistán',
  'uzbekistán', 'uzbekistan', 'vietnam',

  // África
  'argelia', 'algeria', 'angola', 'benín', 'benin', 'botsuana', 'botswana',
  'burkina faso', 'burundi', 'camerún', 'cameroon', 'chad', 'congo', 'costa de marfil',
  'ivory coast', 'egipto', 'egypt', 'etiopía', 'ethiopia', 'gabón', 'gabon', 'gambia',
  'ghana', 'guinea', 'kenia', 'kenya', 'lesoto', 'lesotho', 'liberia', 'libia', 'libya',
  'madagascar', 'malaui', 'malawi', 'malí', 'mali', 'marruecos', 'morocco', 'mauricio',
  'mauritius', 'mauritania', 'mozambique', 'namibia', 'níger', 'niger', 'nigeria',
  'ruanda', 'rwanda', 'senegal', 'somalia', 'sudáfrica', 'south africa', 'sudán', 'sudan',
  'tanzania', 'togo', 'túnez', 'tunisia', 'uganda', 'zambia', 'zimbabue', 'zimbabwe',

  // Oceanía
  'australia', 'fiyi', 'fiji', 'nueva zelanda', 'new zealand', 'papúa nueva guinea',
  'papua new guinea', 'samoa', 'tonga', 'vanuatu'
];

/**
 * Extract country from text, prioritizing title
 * @param {String} title - Article title
 * @param {String} text - Article text
 * @returns {String|null} Country name or null
 */
function extractCountry(title, text) {
  const combinedText = `${title} ${text}`.toLowerCase();

  // Check title first for countries
  const titleLower = title.toLowerCase();
  for (const country of COUNTRIES) {
    if (titleLower.includes(country)) {
      return country;
    }
  }

  // Then check full text
  for (const country of COUNTRIES) {
    if (combinedText.includes(country)) {
      return country;
    }
  }

  return null;
}

/**
 * Extract place names from text using NLP
 * @param {String} text - Article text
 * @param {Boolean} prioritize - If true, these places are higher priority
 * @returns {Array} Array of place names
 */
function extractPlaces(text, prioritize = false) {
  const doc = nlp(text);
  const places = doc.places().out('array');

  // Also look for Uruguayan neighborhoods/cities specifically
  const uruguayanPlaces = [
    'montevideo', 'ciudad vieja', 'pocitos', 'carrasco', 'malvín',
    'punta gorda', 'cordón', 'centro', 'goes', 'la teja', 'cerro',
    'canelones', 'maldonado', 'punta del este', 'salto', 'paysandú',
    'rivera', 'tacuarembó', 'durazno', 'florida', 'rocha'
  ];

  const lowerText = text.toLowerCase();
  const foundPlaces = uruguayanPlaces.filter(place => lowerText.includes(place));

  // Combine and filter out noise words
  const allPlaces = [...new Set([...places, ...foundPlaces])];

  // Filter out common noise words that NLP might incorrectly identify as places
  const noiseWords = [
    'las', 'los', 'la', 'el', 'de', 'del', 'para', 'por', 'con', 'sin',
    'que', 'como', 'donde', 'cuando', 'sobre', 'entre', 'hasta', 'desde'
  ];

  return allPlaces
    .map(place => {
      // Clean up place names: remove punctuation, trim whitespace
      return place.replace(/[,;.!?]/g, '').trim();
    })
    .filter(place => {
      const lowerPlace = place.toLowerCase().trim();
      // Filter out single character places, noise words, and empty strings
      return lowerPlace.length > 1 && !noiseWords.includes(lowerPlace);
    })
    .map(place => ({ name: place, priority: prioritize }));
}

/**
 * Generate deduplication key from article data
 * @param {String} title
 * @param {Date} date
 * @param {Object} location
 * @returns {String} SHA-256 hash
 */
function generateDedupKey(title, date, location) {
  const normalized = title.toLowerCase().replace(/\s+/g, ' ').trim();
  const dateStr = date.toISOString().slice(0, 10);
  const locStr = location ? `${location.coordinates[0].toFixed(3)},${location.coordinates[1].toFixed(3)}` : 'unknown';
  const combined = `${normalized}|${dateStr}|${locStr}`;

  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Parse RSS feed
 * @param {String} url - RSS feed URL
 * @returns {Array} Array of articles
 */
async function parseRssFeed(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Austra-UY/1.0'
      },
      timeout: 10000
    });

    const result = await parseXml(response.data);
    const items = result.rss?.channel?.[0]?.item || [];

    return items.map(item => ({
      title: item.title?.[0] || '',
      link: item.link?.[0] || '',
      description: item.description?.[0] || '',
      pubDate: item.pubDate?.[0] ? new Date(item.pubDate[0]) : new Date()
    }));
  } catch (error) {
    logger.error('Error parsing RSS feed:', { url, error: error.message });
    return [];
  }
}

/**
 * Fetch and parse HTML article
 * @param {String} url - Article URL
 * @returns {String} Article text
 */
async function fetchArticleContent(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Austra-UY/1.0'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);

    // Try common article selectors
    let text = $('article').text() ||
               $('.article-content').text() ||
               $('.post-content').text() ||
               $('main').text();

    return text.trim();
  } catch (error) {
    logger.error('Error fetching article:', { url, error: error.message });
    return '';
  }
}

/**
 * Check if article matches any of the keywords
 * @param {Object} article - Article data
 * @param {Array} keywords - Array of keywords to match
 * @returns {Boolean} True if matches
 */
function matchesKeywords(article, keywords) {
  if (!keywords || keywords.length === 0) {
    return true; // No filter, accept all
  }

  const searchText = `${article.title} ${article.description}`.toLowerCase();
  return keywords.some(keyword => searchText.includes(keyword));
}

/**
 * Create or update incident from news analysis
 * @param {Object} newsEvent - Created news event
 * @param {Object} analysisData - Gemini analysis result
 * @param {String} fullText - Full article text for context
 * @param {SocketIO.Server} io - Socket.IO instance
 * @returns {Object} Created or updated incident, or null
 */

/**
 * Process a single article
 * @param {Object} article - Article data
 * @param {String} sourceName - News source name
 * @param {SocketIO.Server} io - Socket.IO instance
 * @returns {Object} Processed news event or null
 */
async function processArticle(article, sourceName, io) {
  try {
    const startTime = Date.now();

    // Fetch full article content
    const fullText = await fetchArticleContent(article.link);
    const combinedText = `${article.title} ${article.description} ${fullText}`;

    // Classify category
    const category = classifyCategory(combinedText);

    // Extract country from title/description (prioritize title)
    const country = extractCountry(article.title, article.description);

    // Extract places from title (high priority) and content (low priority)
    const titlePlaces = extractPlaces(`${article.title} ${article.description}`, true);
    const contentPlaces = extractPlaces(fullText, false);

    // Combine places: title places first, then content places
    const allPlaces = [...titlePlaces, ...contentPlaces];

    if (allPlaces.length === 0) {
      logger.warn('No places found in article', { url: article.link });
      return null;
    }

    // Sort by priority (true = from title comes first)
    allPlaces.sort((a, b) => (b.priority === true ? 1 : 0) - (a.priority === true ? 1 : 0));

    // Try to geocode places in order of priority (title first, then content)
    // Stop at the first successful geocoding
    let geoResult = null;
    let successfulPlace = null;
    let geocodeQuery = null;

    for (const place of allPlaces) {
      // Build geocoding query
      if (country) {
        // Country explicitly mentioned in title/description
        geocodeQuery = `${place.name}, ${country}`;
      } else {
        // No country mentioned - assume Uruguay (all RSS feeds are Uruguayan)
        // Add "Uruguay" context for better geocoding
        geocodeQuery = `${place.name}, Uruguay`;
      }

      logger.debug('Attempting geocoding', { query: geocodeQuery, priority: place.priority });

      geoResult = await geocode(geocodeQuery);

      if (geoResult) {
        successfulPlace = place.name;
        logger.info('Geocoding successful', {
          place: place.name,
          query: geocodeQuery,
          priority: place.priority ? 'title' : 'content',
          result: geoResult.displayName
        });
        break; // Stop at first successful geocoding
      }

      // Rate limit: wait 1 second between attempts
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!geoResult) {
      logger.warn('Geocoding failed for all places', {
        placesAttempted: allPlaces.length,
        url: article.link
      });
      return null;
    }

    const location = {
      type: 'Point',
      coordinates: [geoResult.lon, geoResult.lat]
    };

    // Generate deduplication key
    const dedupKey = generateDedupKey(article.title, article.pubDate, location);

    // Check if already exists
    const existing = await NewsEvent.findOne({ dedupKey });
    if (existing) {
      logger.info('Duplicate article skipped', { url: article.link });
      return null;
    }

    // Create news event
    const newsEvent = await NewsEvent.create({
      title: article.title,
      source: sourceName,
      url: article.link,
      category,
      location,
      locationName: geoResult.displayName,
      country: geoResult.countryCode || null, // Use detected country or null
      date: article.pubDate,
      confidence: country ? 0.8 : 0.7, // Higher confidence if country was detected
      dedupKey,
      excerpt: article.description,
      entities: allPlaces.map(p => ({
        text: p.name,
        entityType: 'PLACE',
        confidence: p.priority ? 0.9 : 0.7 // Higher confidence for title places
      })),
      metadata: {
        fetchedAt: new Date(),
        processingTime: Date.now() - startTime,
        geocodingMethod: 'nominatim',
        detectedCountry: country,
        geocodeQuery: geocodeQuery,
        successfulPlace: successfulPlace,
        placesFound: allPlaces.length,
        placesAttempted: allPlaces.findIndex(p => p.name === successfulPlace) + 1
      }
    });

    logger.info('News event created', {
      id: newsEvent._id,
      title: newsEvent.title,
      category: newsEvent.category
    });

    // Emit socket event
    if (io) {
      emitNewsAdded(io, newsEvent.toGeoJSON());
    }

    return newsEvent;
  } catch (error) {
    logger.error('Error processing article:', {
      url: article.link,
      error: error.message
    });
    return null;
  }
}

/**
 * Run news ingestion job
 * Always filters articles by security keywords from .env
 * @param {SocketIO.Server} io - Socket.IO instance
 */
export async function runNewsIngestion(io) {
  // Get security keywords from environment (always filter by security topics)
  const securityKeywords = process.env.NEWS_SECURITY_KEYWORDS
    ? process.env.NEWS_SECURITY_KEYWORDS.split(',').map(k => k.trim().toLowerCase())
    : [];

  logger.info('Starting news ingestion job', {
    securityKeywordsCount: securityKeywords.length,
    filteringEnabled: securityKeywords.length > 0
  });
  const startTime = Date.now();

  let totalProcessed = 0;
  let totalCreated = 0;
  let totalFailed = 0;
  let totalFiltered = 0;

  for (const source of NEWS_SOURCES) {
    try {
      logger.info('Processing news source', { source: source.name });

      const articles = await parseRssFeed(source.rssUrl);
      logger.info(`Found ${articles.length} articles from ${source.name}`);

      for (const article of articles) {
        // Filter by security keywords (always enabled)
        if (!matchesKeywords(article, securityKeywords)) {
          totalFiltered++;
          logger.debug('Article filtered out (no security keywords)', {
            title: article.title.substring(0, 100)
          });
          continue;
        }

        totalProcessed++;
        const result = await processArticle(article, source.name, io);

        if (result) {
          totalCreated++;
        } else {
          totalFailed++;
        }

        // Rate limit: 1 request per second to geocoding API
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      logger.error('Error processing news source:', {
        source: source.name,
        error: error.message
      });
    }
  }

  const duration = Date.now() - startTime;
  logger.info('News ingestion completed', {
    totalProcessed,
    totalCreated,
    totalFailed,
    totalFiltered,
    durationMs: duration
  });

  return {
    totalProcessed,
    totalCreated,
    totalFailed,
    totalFiltered,
    durationMs: duration
  };
}
