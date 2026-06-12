// ── POST /api/payment ──
// AI-powered payment verification using Gemini Vision.
// 1. Parses uploaded screenshot (multipart/form-data)
// 2. Sends image to Gemini to verify payment amount + plan match
// 3. On success → instantly updates D1 users.plan
// 4. Saves proof to GitHub repo for audit log
// Replaces payment.php

import { IncomingForm } from 'formidable';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { d1Run } from './_lib/d1.js';
import { PLAN_PRICES_INR } from './_lib/plans.js';

// Disable Vercel's built-in body parser so formidable can handle raw multipart
export const config = { api: { bodyParser: false } };

const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_OWNER   = process.env.GITHUB_OWNER;
const GITHUB_STORAGE = process.env.GITHUB_REPO_STORAGE;
const GEMINI_KEY     = process.env.GEMINI_API_KEY;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('POST only');

  // ── 1. Parse multipart form ──
  const form = new IncomingForm({ maxFileSize: 10 * 1024 * 1024, keepExtensions: true });

  let fields, files;
  try {
    [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, f, fi) => err ? reject(err) : resolve([f, fi]));
    });
  } catch {
    return res.status(400).send('Error: Could not parse upload.');
  }

  const username   = (fields.username?.[0] ?? '').replace(/[^a-zA-Z0-9-]/g, '');
  const plan       = (fields.plan?.[0]     ?? '').replace(/[^a-zA-Z]/g, '');
  const txnid      = (fields.txnid?.[0]    ?? '').replace(/[^a-zA-Z0-9]/g, '');
  const fileEntry  = files.screenshot?.[0] ?? files.screenshot;

  if (!username || !plan || !txnid || !fileEntry) {
    return res.status(400).send('Error: Missing fields (username, plan, txnid, screenshot).');
  }

  const expectedPrice = PLAN_PRICES_INR[plan];
  if (!expectedPrice) {
    return res.status(400).send('Error: Invalid plan selected.');
  }

  // ── 2. Read the image file ──
  const imgPath = fileEntry.filepath ?? fileEntry.path;
  let imgBuffer;
  try {
    imgBuffer = fs.readFileSync(imgPath);
  } catch {
    return res.status(400).send('Error: Could not read uploaded file.');
  }
  const base64Img  = imgBuffer.toString('base64');
  const mimeType   = fileEntry.mimetype ?? 'image/jpeg';

  // ── 3. Gemini Vision verification ──
  let geminiApproved = false;
  let geminiReason   = 'AI scan failed';

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt = [
      `You are a payment verification AI for Absora Cloud hosting.`,
      `A user claims to have paid ₹${expectedPrice} INR for the "${plan}" plan.`,
      `Analyze the screenshot and respond ONLY with a JSON object in this exact format:`,
      `{"valid": true/false, "amount_found": <number or null>, "transaction_id": "<string or null>", "reason": "<short explanation>"}`,
      `Return valid=true ONLY if: the payment is clearly successful, the amount is ≥ ₹${expectedPrice}, and this looks like a real UPI/bank receipt.`,
      `Be strict — reject blurry, edited, or insufficient amount screenshots.`,
    ].join(' ');

    const result = await model.generateContent([
      { text: prompt },
      { inlineData: { mimeType, data: base64Img } },
    ]);

    const raw = result.response.text().trim();
    // Strip markdown code fences if present
    const jsonStr = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed  = JSON.parse(jsonStr);

    geminiApproved = parsed.valid === true;
    geminiReason   = parsed.reason ?? 'No reason provided';

    console.log(`[payment] Gemini verdict for ${username}/${plan}: valid=${parsed.valid}, amount=${parsed.amount_found}, reason=${parsed.reason}`);
  } catch (err) {
    console.error('[payment] Gemini error:', err);
    // Don't approve if Gemini fails
    return res.send('Error: AI payment scanner unavailable. Contact admin.');
  }

  if (!geminiApproved) {
    return res.send(`Error: Payment not verified. ${geminiReason}`);
  }

  // ── 4. Save proof screenshot to GitHub (audit log) ──
  try {
    const gitPath   = `payments/${username}_${plan}_${txnid}.jpg`;
    const uploadUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_STORAGE}/contents/${gitPath}`;
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent':    'Absora-API',
        'Accept':        'application/vnd.github.v3+json',
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        message: `Payment Proof: ${username} → ${plan}`,
        content: base64Img,
      }),
    });
  } catch (err) {
    console.warn('[payment] GitHub upload failed (non-fatal):', err.message);
    // Continue — audit log failure should not block the upgrade
  }

  // ── 5. Upgrade plan in D1 ──
  try {
    await d1Run('UPDATE users SET plan = ? WHERE username = ?', [plan, username]);
  } catch (err) {
    console.error('[payment] D1 update failed:', err);
    return res.send('Error: Payment verified but plan update failed. Contact admin.');
  }

  return res.send(`Success! Your plan has been upgraded to ${plan}. Reload the console.`);
}
