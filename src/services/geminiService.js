import { GoogleGenerativeAI } from '@google/generative-ai';
import logger from '../utils/logger.js';

/**
 * Initialize Gemini AI lazily to ensure env vars are loaded
 */
function getGeminiModel() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured in .env file');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  return genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
  });
}

/**
 * Analyze a news article to extract incident information
 * Returns structured data if the article contains a specific location and crime type
 * @param {String} title - Article title
 * @param {String} content - Article content
 * @param {String} url - Article URL (for caching)
 * @returns {Object|null} { locationType, locationName, incidentType, severity, description } or null
 */
export async function analyzeNewsForIncident(title, content, url) {
  try {
    // Check if Gemini API key is configured
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      logger.warn('GEMINI_API_KEY not configured, skipping analysis');
      return null;
    }

    // Log API key info for debugging (only first/last 4 chars)
    logger.debug('Using Gemini API key', {
      keyPrefix: apiKey.substring(0, 4),
      keySuffix: apiKey.substring(apiKey.length - 4),
      keyLength: apiKey.length
    });

    // Prepare prompt for Gemini
    const prompt = `Analiza la siguiente noticia y extrae información estructurada SOLO si se cumplen TODAS estas condiciones:
1. La noticia describe un incidente criminal/delictivo
2. Se menciona una ubicación ESPECÍFICA (calle, esquina, o barrio concreto) en Uruguay
3. El incidente es reciente o relevante para alertas de seguridad

Noticia:
Título: ${title}
Contenido: ${content}

Responde ÚNICAMENTE con un objeto JSON válido (sin markdown, sin bloques de código, solo el JSON) con esta estructura:
{
  "hasIncident": true/false,
  "locationType": "street" | "neighborhood" | null,
  "locationName": "nombre exacto de la calle/esquina/barrio mencionado (ej: 'Bulevar Artigas y Rivera', 'Pocitos', 'Ciudad Vieja')" | null,
  "incidentType": "homicidio" | "rapiña" | "hurto" | "copamiento" | "violencia_domestica" | "narcotrafico" | "otro" | null,
  "severity": 1-5 (número basado en gravedad) | null,
  "description": "breve descripción del incidente (máximo 200 caracteres)" | null
}

IMPORTANTE:
- Si NO hay ubicación específica (solo dice "Montevideo" o "Uruguay" sin más detalles), devuelve hasIncident: false
- Si NO es un incidente criminal, devuelve hasIncident: false
- locationName debe ser exactamente como aparece en la noticia
- incidentType debe ser uno de los valores del enum especificado
- severity: 1=leve, 2=moderado, 3=significativo, 4=grave, 5=muy grave
- description debe ser objetiva y concisa

Responde SOLO con el JSON, sin texto adicional.`;

    // Call Gemini API
    logger.info('Calling Gemini API for incident analysis', {
      url,
      titleLength: title.length,
      contentLength: content.length
    });

    const model = getGeminiModel();
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // Parse JSON response
    let analysisData;
    try {
      // Remove markdown code blocks if present
      const cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analysisData = JSON.parse(cleanText);
    } catch (parseError) {
      logger.error('Failed to parse Gemini JSON response', {
        url,
        text,
        error: parseError.message
      });
      return null;
    }

    // Validate response structure
    if (!analysisData || typeof analysisData.hasIncident !== 'boolean') {
      logger.error('Invalid Gemini response structure', { url, analysisData });
      return null;
    }

    // If no incident detected, return null
    if (!analysisData.hasIncident) {
      logger.info('No incident detected by Gemini', { url });

      return null;
    }

    // Validate that all required fields are present
    if (!analysisData.locationName || !analysisData.incidentType || !analysisData.severity) {
      logger.warn('Gemini detected incident but missing required fields', {
        url,
        analysisData
      });
      return null;
    }

    // Validate incident type
    const validTypes = [
      'homicidio', 'rapiña', 'hurto', 'copamiento',
      'violencia_domestica', 'narcotrafico', 'otro'
    ];
    if (!validTypes.includes(analysisData.incidentType)) {
      logger.warn('Invalid incident type from Gemini', {
        url,
        incidentType: analysisData.incidentType
      });
      return null;
    }

    // Validate severity range
    if (analysisData.severity < 1 || analysisData.severity > 5) {
      logger.warn('Invalid severity from Gemini', {
        url,
        severity: analysisData.severity
      });
      analysisData.severity = 3; // Default to moderate
    }

    const result_data = {
      locationType: analysisData.locationType,
      locationName: analysisData.locationName,
      incidentType: analysisData.incidentType,
      severity: analysisData.severity,
      description: analysisData.description || title.substring(0, 200)
    };

    logger.info('Gemini analysis successful', { url, result: result_data });
    return result_data;

  } catch (error) {
    logger.error('Gemini API error:', {
      url,
      error: error.message,
      stack: error.stack
    });
    return null;
  }
}

/**
 * Validate if a user-reported incident is relevant for publication
 * Uses Gemini to determine if the incident is related to public safety
 * @param {Object} incidentData - The incident data to validate
 * @param {String} incidentData.type - Incident type (homicidio, rapiña, etc.)
 * @param {String} incidentData.description - User's description
 * @param {Number} incidentData.severity - Severity (1-5)
 * @returns {Object} { isValid: boolean, reason: string }
 */
export async function validateIncidentRelevance(incidentData) {
  try {
    // Check if Gemini API key is configured
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      logger.warn('GEMINI_API_KEY not configured, allowing incident by default');
      return {
        isValid: true,
        reason: 'Validación automática desactivada'
      };
    }

    const { type, description, severity } = incidentData;

    // Prepare prompt for Gemini
    const prompt = `Eres un moderador de una plataforma de seguridad ciudadana en Uruguay llamada "Centinel". Tu trabajo es determinar si un reporte de incidente es RELEVANTE para publicarse en la plataforma.

DATOS DEL INCIDENTE REPORTADO:
- Tipo: ${type}
- Descripción: ${description || '(sin descripción)'}
- Severidad: ${severity}/5

CRITERIOS DE VALIDACIÓN:

✅ VÁLIDO (debe publicarse) si:
- Es un incidente real de seguridad pública (robos, asaltos, delitos, actividad sospechosa)
- Es una situación que afecta o podría afectar la seguridad de la comunidad
- Aunque sea breve, describe un evento criminal o de riesgo

❌ INVÁLIDO (NO debe publicarse) si:
- Es una queja personal no relacionada con seguridad ("me quedé sin leche", "mi vecino es ruidoso")
- Es spam, contenido sin sentido o irrelevante
- Es un problema cotidiano sin implicaciones de seguridad
- Está vacío o sin información útil
- Es claramente falso o broma

INSTRUCCIONES:
1. Analiza si el incidente reportado es relevante para seguridad ciudadana
2. Ten criterio flexible: si hay duda razonable de que podría ser relevante, ACEPTA el reporte
3. Solo rechaza reportes claramente irrelevantes o spam

Responde ÚNICAMENTE con un objeto JSON válido (sin markdown, sin bloques de código, solo el JSON):
{
  "isValid": true/false,
  "reason": "Explicación breve (máximo 100 caracteres) de por qué es válido o inválido"
}

Responde SOLO con el JSON, sin texto adicional.`;

    logger.info('Validating incident with Gemini', {
      type,
      descriptionLength: description?.length || 0,
      severity
    });

    const model = getGeminiModel();
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // Parse JSON response
    let validationResult;
    try {
      // Remove markdown code blocks if present
      const cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      validationResult = JSON.parse(cleanText);
    } catch (parseError) {
      logger.error('Failed to parse Gemini validation response', {
        text,
        error: parseError.message,
        type: incidentData.type
      });
      // On parse error, fail-closed (reject for manual review)
      return {
        isValid: false,
        reason: 'El reporte requiere revisión manual. Contacta soporte si crees que es un error.'
      };
    }

    // Validate response structure
    if (typeof validationResult.isValid !== 'boolean' || !validationResult.reason) {
      logger.error('Invalid Gemini validation response structure', {
        validationResult,
        type: incidentData.type
      });
      // On invalid structure, fail-closed (reject for manual review)
      return {
        isValid: false,
        reason: 'El reporte requiere revisión manual. Contacta soporte si crees que es un error.'
      };
    }

    logger.info('Gemini validation result', {
      type,
      isValid: validationResult.isValid,
      reason: validationResult.reason
    });

    return validationResult;

  } catch (error) {
    logger.error('Gemini validation error:', {
      error: error.message,
      stack: error.stack,
      type: incidentData.type
    });

    // Fail-closed strategy with degradation:
    // - Network/timeout errors: fail-open (temporary service issues)
    // - Other errors: fail-closed (require manual review)
    const isNetworkError = error.message?.includes('timeout') ||
                          error.message?.includes('ECONNREFUSED') ||
                          error.message?.includes('ETIMEDOUT') ||
                          error.message?.includes('network');

    if (isNetworkError) {
      logger.warn('Network error in Gemini validation, allowing incident (fail-open for availability)', {
        type: incidentData.type,
        error: error.message
      });
      return {
        isValid: true,
        reason: 'Validación automática no disponible temporalmente'
      };
    }

    // For non-network errors, fail closed (reject and require manual review)
    logger.warn('Gemini validation failed, rejecting incident for manual review (fail-closed)', {
      type: incidentData.type,
      error: error.message
    });
    return {
      isValid: false,
      reason: 'El reporte requiere revisión manual. Contacta soporte si crees que es un error.'
    };
  }
}
