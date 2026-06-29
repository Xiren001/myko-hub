"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// POST /api/translate
// Body: { corrections: CorrectionSnippet[], language: 'ES' | 'DE' }
// Returns: { translations: CorrectionSnippet[] }
router.post('/', auth_1.authenticate, async (req, res) => {
    const { corrections, language } = req.body;
    if (!corrections?.length)
        return res.json({ translations: [] });
    const langName = language === 'DE' ? 'German' : 'Spanish';
    try {
        const client = new sdk_1.default();
        const message = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 4096,
            messages: [
                {
                    role: 'user',
                    content: `You are a professional translator. Translate the following proofreading correction data from ${langName} to English.

Return ONLY a valid JSON array — no markdown, no explanation. Keep the same structure and keep "id" unchanged. Translate: location, original_text, corrected_text, issue_type, notes. Leave null values as null.

${JSON.stringify(corrections)}`,
                },
            ],
        });
        const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '[]';
        // Strip any markdown code fences Claude might add
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const translations = JSON.parse(cleaned);
        res.json({ translations });
    }
    catch (err) {
        console.error('Translation error:', err);
        res.status(500).json({ error: 'Translation failed' });
    }
});
exports.default = router;
