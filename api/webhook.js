/**
 * BOTSITE – Vercel Serverless Webhook
 * ─────────────────────────────────────────────────────────────────────
 * Ablauf:
 *  1. Resend empfängt eingehende E-Mail und schickt Webhook-POST (JSON)
 *  2. E-Mail + aktuelle SITE_DATA werden an Claude geschickt
 *  3. Claude entscheidet: Änderung / Rückfrage / Dateien / Komplex
 *  4. Bei Änderung: GitHub-Datei wird aktualisiert (commit)
 *  5. Antwort-E-Mail wird per Resend API versendet
 *
 * Erforderliche Umgebungsvariablen: siehe .env.example
 */

import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';

// ── Konfiguration ─────────────────────────────────────────────────────
const AI_NAME  = process.env.AI_NAME    || 'Hans';
const AI_EMAIL = process.env.AI_EMAIL   || 'hans@botsite.de';
const SITE_URL = process.env.WEBSITE_URL || '';

const SITE_DATA_REGEX = /\/\/ @SITE_DATA_START\s*([\s\S]*?)\s*\/\/ @SITE_DATA_END/;

// ── Vercel Body-Parser Konfiguration ─────────────────────────────────
// Resend sendet JSON → Standard-Parser reicht
export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

// ════════════════════════════════════════════════════════════════════════
// GITHUB: Datei lesen
// ════════════════════════════════════════════════════════════════════════
async function githubGetFile() {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env;
  const filePath = process.env.GITHUB_FILE_PATH || 'index.html';
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Botsite-KI/1.0',
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub GET ${res.status}: ${err}`);
  }

  const data = await res.json();
  return {
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
    sha: data.sha,
  };
}

// ════════════════════════════════════════════════════════════════════════
// GITHUB: Datei aktualisieren (commit)
// ════════════════════════════════════════════════════════════════════════
async function githubUpdateFile(newContent, sha, commitMessage) {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env;
  const filePath = process.env.GITHUB_FILE_PATH || 'index.html';
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Botsite-KI/1.0',
    },
    body: JSON.stringify({
      message: commitMessage,
      content: Buffer.from(newContent).toString('base64'),
      sha,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub PUT ${res.status}: ${err}`);
  }
  return res.json();
}

// ════════════════════════════════════════════════════════════════════════
// SITE_DATA: Aus HTML extrahieren
// ════════════════════════════════════════════════════════════════════════
function extractSiteData(html) {
  const match = html.match(SITE_DATA_REGEX);
  if (!match) throw new Error('SITE_DATA-Marker nicht in index.html gefunden');
  return match[1].trim();
}

// ════════════════════════════════════════════════════════════════════════
// SITE_DATA: In HTML ersetzen
// ════════════════════════════════════════════════════════════════════════
function replaceSiteData(html, newSiteDataBlock) {
  // newSiteDataBlock ist der vollständige JavaScript-Code ("const SITE_DATA = {...};")
  const replacement = `// @SITE_DATA_START\n${newSiteDataBlock.trim()}\n// @SITE_DATA_END`;
  const updated = html.replace(SITE_DATA_REGEX, replacement);
  if (updated === html) throw new Error('SITE_DATA-Ersetzung fehlgeschlagen');
  return updated;
}

// ════════════════════════════════════════════════════════════════════════
// GITHUB: Bild hochladen (für E-Mail-Anhänge)
// ════════════════════════════════════════════════════════════════════════
async function githubUploadImage(filename, base64Content) {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env;

  // Sicherer Dateiname (Leerzeichen etc. entfernen)
  const safeName  = filename.replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase();
  const timestamp = Date.now();
  const filePath  = `assets/images/${timestamp}_${safeName}`;
  const url       = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization:  `token ${GITHUB_TOKEN}`,
      Accept:         'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent':   'Botsite-KI/1.0',
    },
    body: JSON.stringify({
      message: `Botsite: Bild hochgeladen – ${safeName}`,
      content: base64Content, // bereits Base64 von Resend
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub Bild-Upload ${res.status}: ${err}`);
  }

  // Öffentliche GitHub Pages URL
  const pagesUrl = `https://${GITHUB_OWNER.toLowerCase()}.github.io/${GITHUB_REPO}/${filePath}`;
  console.log(`[botsite] Bild hochgeladen: ${pagesUrl}`);
  return { filePath, pagesUrl, safeName };
}

// ════════════════════════════════════════════════════════════════════════
// RESEND: E-Mail senden
// ════════════════════════════════════════════════════════════════════════
async function sendEmail(to, subject, text) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from:    `${AI_NAME} <${AI_EMAIL}>`,
    to:      [to],
    subject: subject,
    text:    text,
  });
  if (error) console.error('[botsite] Resend Fehler:', error);
}

// ════════════════════════════════════════════════════════════════════════
// CLAUDE: E-Mail verarbeiten und Entscheidung treffen
// ════════════════════════════════════════════════════════════════════════
async function processWithClaude(siteDataCode, senderEmail, emailSubject, emailBody, uploadedImages = []) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `Du bist ${AI_NAME}, ein freundlicher und kompetenter KI-Website-Betreuer.
Du betreust die Website eines kleinen Unternehmens. Kunden schicken dir E-Mails mit Änderungswünschen.${SITE_URL ? `\nWebsite-URL: ${SITE_URL}` : ''}

═══ DEINE AUFGABE ═══
1. Verstehe die Anfrage im E-Mail
2. Klassifiziere sie in einen der 4 Typen
3. Antworte AUSSCHLIESSLICH mit einem validen JSON-Objekt (kein Markdown, keine Code-Blöcke)

═══ AKTIONSTYPEN ═══
• ÄNDERUNG   – Klare, einfache Inhaltsänderung (Texte, Preise, Zeiten, Ankündigungen, Specials)
• RÜCKFRAGE  – Anfrage ist unklar oder mehrdeutig → gezielt nachfragen
• DATEIEN    – Änderung benötigt Fotos die noch nicht mitgeschickt wurden
• KOMPLEX    – Strukturelle Änderungen, neues Design, neue Seiten (wird manuell besprochen)

═══ JSON-ANTWORTFORMAT ═══
{
  "action":        "ÄNDERUNG" | "RÜCKFRAGE" | "DATEIEN" | "KOMPLEX",
  "reasoning":     "Kurze interne Begründung (max. 1 Satz)",
  "email_response": "Vollständige, freundliche E-Mail-Antwort auf Deutsch (mit Anrede, Text, Grußformel)",
  "new_site_data": "...JavaScript-Code..."
}

Das Feld "new_site_data" ist NUR bei action=ÄNDERUNG nötig und enthält:
• Den VOLLSTÄNDIGEN, gültigen JavaScript-Code beginnend mit "const SITE_DATA = {"
• Schließend mit "};"
• ALLE Felder exakt erhalten, nur die angefragten Felder geändert
• Korrektes JavaScript ohne Syntaxfehler
• last_updated auf das heutige Datum gesetzt (${new Date().toISOString().split('T')[0]})

Bei der email_response:
• Persönliche Anrede (verwende den Vornamen wenn erkennbar)
• Freundlich, professionell, auf Deutsch
• Bei ÄNDERUNG: bestätige die Änderung konkret, nenne die Website-URL
• Unterzeichne immer mit "${AI_NAME}"`;

  // Bilder-Abschnitt für Claude vorbereiten
  const imagesSection = uploadedImages.length > 0
    ? `\n━━━ HOCHGELADENE BILDER (bereits auf GitHub) ━━━\n` +
      uploadedImages.map(img =>
        `• ${img.safeName}\n  URL: ${img.pagesUrl}`
      ).join('\n') +
      `\n\nDiese Bild-URLs kannst du direkt in SITE_DATA verwenden (z.B. als "image"-Feld).`
    : '';

  const userMessage = `Aktuelle SITE_DATA der Website:
\`\`\`javascript
${siteDataCode}
\`\`\`

━━━ NEUE E-MAIL ━━━
Von: ${senderEmail}
Betreff: ${emailSubject}

${emailBody}${imagesSection}`;

  const response = await anthropic.messages.create({
    model:      'claude-opus-4-5',
    max_tokens: 4096,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userMessage }],
  });

  const rawText = response.content[0].text.trim();

  // JSON extrahieren (sicher auch wenn Claude Markdown-Wrapper hinzufügt)
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('[botsite] Claude-Antwort enthält kein JSON:', rawText.substring(0, 200));
    throw new Error('Kein JSON in Claude-Antwort');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[botsite] JSON-Parse-Fehler:', e.message, '\nText:', jsonMatch[0].substring(0, 300));
    throw new Error('Claude-Antwort ist kein valides JSON');
  }

  if (!['ÄNDERUNG', 'RÜCKFRAGE', 'DATEIEN', 'KOMPLEX'].includes(parsed.action)) {
    throw new Error(`Unbekannte Claude-Action: ${parsed.action}`);
  }

  return parsed;
}

// ════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  // CORS-Header für Browser-Test-Seite
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight-Request (Browser sendet OPTIONS vor POST)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Nur POST erlaubt
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Resend Webhook-Payload (JSON) ──────────────────────────────────
  // Resend sendet: { type: "email.received", data: { from, to, subject, text, ... } }
  const payload = req.body;
  const emailData = payload?.data ?? payload; // Fallback falls kein "data"-Wrapper

  // ── E-Mail-Felder extrahieren ───────────────────────────────────────
  const sender  = emailData?.from || '';
  const subject = emailData?.subject || '(Kein Betreff)';

  // Plain-Text bevorzugen, HTML als Fallback (iCloud sendet oft nur HTML)
  let emailBody = emailData?.text || emailData?.['body-plain'] || '';
  if (!emailBody && (emailData?.html || emailData?.['body-html'])) {
    const html = emailData?.html || emailData?.['body-html'] || '';
    // HTML-Tags entfernen → Plain Text
    emailBody = html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  if (!sender) {
    console.warn('[botsite] Kein Absender in Webhook');
    return res.status(400).json({ error: 'No sender' });
  }

  // ── Anhänge (Bilder) aus Resend-Payload ────────────────────────────
  const attachments = emailData?.attachments || [];
  const IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

  console.log(`[botsite] Neue E-Mail von ${sender} | Betreff: "${subject}" | Anhänge: ${attachments.length}`);

  // ── Hauptverarbeitung ───────────────────────────────────────────────
  try {
    // 1. Aktuelle Website laden
    const { content: html, sha } = await githubGetFile();
    const siteDataCode = extractSiteData(html);
    console.log('[botsite] GitHub-Datei geladen, SHA:', sha.substring(0, 8));

    // 2. Bilder-Anhänge zu GitHub hochladen
    const uploadedImages = [];
    for (const att of attachments) {
      const isImage = IMAGE_TYPES.includes((att.contentType || '').toLowerCase());
      if (!isImage) continue;
      try {
        const uploaded = await githubUploadImage(att.filename || 'bild.jpg', att.content);
        uploadedImages.push(uploaded);
      } catch (imgErr) {
        console.error('[botsite] Bild-Upload fehlgeschlagen:', imgErr.message);
      }
    }
    if (uploadedImages.length > 0) {
      console.log(`[botsite] ${uploadedImages.length} Bild(er) hochgeladen`);
    }

    // 3. Claude entscheiden lassen (inkl. Bild-URLs)
    const result = await processWithClaude(siteDataCode, sender, subject, emailBody, uploadedImages);
    console.log(`[botsite] Claude-Entscheidung: ${result.action} | ${result.reasoning}`);

    // 3. Bei ÄNDERUNG: GitHub aktualisieren
    if (result.action === 'ÄNDERUNG' && result.new_site_data) {
      const updatedHtml = replaceSiteData(html, result.new_site_data);
      const commitMsg   = `Botsite: ${subject.substring(0, 72)} (${sender})`;
      await githubUpdateFile(updatedHtml, sha, commitMsg);
      console.log('[botsite] GitHub erfolgreich aktualisiert');
    }

    // 4. Antwort-E-Mail senden
    await sendEmail(sender, `Re: ${subject}`, result.email_response);
    console.log(`[botsite] Antwort gesendet an ${sender}`);

    return res.status(200).json({
      success:   true,
      action:    result.action,
      reasoning: result.reasoning,
    });

  } catch (error) {
    console.error('[botsite] Verarbeitungsfehler:', error.message);

    // Fallback-E-Mail an Absender senden
    if (sender) {
      try {
        const fallback = `Guten Tag,

leider ist bei der Verarbeitung Ihrer Anfrage ein technischer Fehler aufgetreten. Bitte entschuldigen Sie die Unannehmlichkeiten.

Ich werde mich so schnell wie möglich persönlich bei Ihnen melden.

Mit freundlichen Grüßen,
${AI_NAME}`;
        await sendEmail(sender, `Re: ${subject}`, fallback);
      } catch (mailErr) {
        console.error('[botsite] Fallback-E-Mail fehlgeschlagen:', mailErr.message);
      }
    }

    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
