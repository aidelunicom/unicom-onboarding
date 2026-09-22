/*
 * PDF relay endpoint for Zapier: decodes base64 into a real binary PDF
 * response so Zapier's Webhooks step gets a genuine file object instead of
 * a text string, which is what Google Drive/Gmail's file fields require.
 */
module.exports = async (req, res) => {
    if (req.method !== 'POST') {
          res.status(405).json({ error: 'Use POST' });
          return;
    }

    try {
          var body = req.body;
          if (typeof body === 'string') {
                  try { body = JSON.parse(body); } catch (e) { body = {}; }
          }
          body = body || {};

      var expected = process.env.PDF_RELAY_SECRET;
          if (expected && body.secret !== expected) {
                  res.status(403).json({ error: 'Invalid or missing secret' });
                  return;
          }

      var b64 = body.base64 || '';
          if (typeof b64 !== 'string' || !b64) {
                  res.status(400).json({ error: 'Missing base64 field' });
                  return;
          }
          if (b64.slice(0, 5) === 'data:') {
                  var comma = b64.indexOf(',');
                  if (comma >= 0) b64 = b64.slice(comma + 1);
          }

      var buf = Buffer.from(b64, 'base64');
          if (!buf.length) {
                  res.status(400).json({ error: 'Decoded to 0 bytes' });
                  return;
          }

      var filename = (body.filename || 'document.pdf').toString().replace(/[\r\n"]/g, '');
          if (!/\.pdf$/i.test(filename)) filename += '.pdf';

      res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
          res.setHeader('Content-Length', String(buf.length));
          res.status(200).send(buf);
    } catch (err) {
          res.status(500).json({ error: 'Relay error: ' + (err && err.message ? err.message : String(err)) });
    }
};
