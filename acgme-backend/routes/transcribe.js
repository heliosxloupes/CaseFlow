const express = require('express');
const router = express.Router();
const multer = require('multer');
const Groq = require('groq-sdk');
const { toFile } = require('groq-sdk');
const { logActivity } = require('../services/logService');
const { getSpecialty } = require('../config/specialties');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB — Groq limit
});

/**
 * POST /api/transcribe
 * Accepts multipart/form-data:
 *   audio     — audio blob (webm, mp4, m4a, ogg, wav)
 *   sites     — JSON array of hospital/site names (optional)
 *   attendings — JSON array of attending names (optional)
 * Returns: { transcript: string }
 */
router.post('/', upload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer.length) {
      return res.status(400).json({ error: 'No audio file received' });
    }

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      return res.status(503).json({ error: 'Transcription not configured (missing GROQ_API_KEY)' });
    }

    // Parse optional context arrays for vocabulary seeding
    let sites = [];
    let attendings = [];
    try { sites = JSON.parse(req.body.sites || '[]'); } catch (_) {}
    try { attendings = JSON.parse(req.body.attendings || '[]'); } catch (_) {}

    // Specialty-aware Whisper vocabulary hint
    const specialty = req.body.specialty || req.userSpecialty || 'plastic-surgery';
    const BASE_PROMPT = getSpecialty(specialty).whisperHint;

    // Build prompt under Groq's 896-char hard limit
    const promptParts = [BASE_PROMPT];
    if (sites.length) promptParts.push(`Hospitals: ${sites.slice(0, 5).join(', ')}.`);
    if (attendings.length) promptParts.push(`Attendings: ${attendings.slice(0, 8).join(', ')}.`);
    const prompt = promptParts.join(' ').slice(0, 890);

    // Determine file extension from MIME type for Groq's file-type detection
    const mime = req.file.mimetype || 'audio/webm';
    const ext = mime.includes('mp4') || mime.includes('m4a') ? 'm4a'
              : mime.includes('ogg') ? 'ogg'
              : mime.includes('wav') ? 'wav'
              : 'webm';

    const groq = new Groq({ apiKey: groqKey });
    const audioFile = await toFile(req.file.buffer, `recording.${ext}`, { type: mime });

    const result = await groq.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-large-v3-turbo',
      prompt,
      language: 'en',
      response_format: 'text',
    });

    // groq returns a plain string when response_format is 'text'
    const transcript = typeof result === 'string' ? result.trim() : (result.text || '').trim();

    console.log(`[transcribe] user=${req.userId} len=${req.file.size}b → "${transcript.slice(0, 120)}"`);
    await logActivity({
      userId: req.userId,
      userEmail: req.userEmail,
      eventType: 'voice.transcribe',
      message: 'Audio transcription requested',
      context: {
        bytes: req.file.size,
        transcriptPreview: transcript.slice(0, 120),
      },
    });
    res.json({ transcript });
  } catch (err) {
    console.error('[transcribe] error:', err.message);
    next(err);
  }
});

module.exports = router;
