const { put, head, del } = require('@vercel/blob');
const crypto = require('crypto');

/* Server-side "save & resume" storage for the onboarding wizard.
   Replaces the old design where the ENTIRE form (including signature images
      and uploaded phone-bill/invoice files) was base64-encoded directly into
         the shareable URL's hash -- anyone with that link, or anyone who saw it
            in a browser history/proxy log/shared screen, had full read access to
               everything in it, forever, with no way to revoke it.

                  Now the browser never holds the actual data in the URL. It POSTs the
                     form state here, gets back a short random id, and the shareable link is
                        just "?d=<id>" on our own domain. The id is a 72-bit random token
                           (crypto-random, not guessable/enumerable) that doubles as the Blob
                              pathname, so knowing the link is still exactly what's required to read
                                 or resume a draft -- same trust model as before for the people you
                                    actually share it with -- but the link itself no longer carries the
                                       data, so it's short, and a draft can be deleted (see the DELETE handler
                                          and submitData()'s post-submit cleanup) instead of living forever
                                             wherever it was pasted. */

var ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

function isValidId(id) {
    return typeof id === 'string' && ID_RE.test(id);
}

function draftPath(id) {
    return 'onboarding-drafts/' + id + '.json';
}

var MAX_DRAFT_BYTES = 20 * 1024 * 1024; // generous -- comfortably covers signature images + a couple of uploaded bills/invoices

module.exports = async (req, res) => {
    try {
          if (req.method === 'POST') {
                  var body = req.body;
                          if (typeof body === 'string') {
                            try { body = JSON.parse(body); } catch (e) { body = {}; }
                  }
                  body = body || {};

                  if (!body.state || typeof body.state !== 'object') {
                            res.status(400).json({ error: 'Missing state to save' });
                            return;
                  }

                  var id = isValidId(body.id) ? body.id : crypto.randomBytes(9).toString('base64url');
                  var json = JSON.stringify(body.state);

                  if (Buffer.byteLength(json, 'utf8') > MAX_DRAFT_BYTES) {
                            res.status(413).json({ error: 'This saved progress is too large to store -- try removing an uploaded file and saving again.' });
                            return;
                  }

                  await put(draftPath(id), json, {
                            access: 'public',
                            contentType: 'application/json',
                            addRandomSuffix: false,
                            allowOverwrite: true,
                  });

                  res.status(200).json({ ok: true, id: id });
                  return;
          }

          if (req.method === 'GET') {
                  var qid = req.query && req.query.id;
                  if (!isValidId(qid)) {
                            res.status(400).json({ error: 'Invalid or missing id' });
                            return;
                  }

                  var meta;
                  try {
                            meta = await head(draftPath(qid));
                  } catch (e) {
                            res.status(404).json({ error: 'No saved progress found for this link -- it may have already been submitted or removed.' });
                            return;
                  }

                  var blobResp = await fetch(meta.url);
                  if (!blobResp.ok) {
                            res.status(404).json({ error: 'No saved progress found for this link.' });
                            return;
                  }
                  var state = await blobResp.json();
                  res.status(200).json({ ok: true, state: state });
                  return;
          }

          if (req.method === 'DELETE') {
                  var did = (req.query && req.query.id) || (req.body && req.body.id);
                  if (!isValidId(did)) {
                            res.status(400).json({ error: 'Invalid or missing id' });
                            return;
                  }
                  try {
                            await del(draftPath(did));
                  } catch (e) {
                            // Already gone or never existed -- deletion is best-effort cleanup,
                            // not something that should ever block or fail the caller.
                  }
                  res.status(200).json({ ok: true });
                  return;
          }

          res.status(405).json({ error: 'Use GET, POST, or DELETE' });
    } catch (err) {
          res.status(500).json({ error: 'Draft error: ' + (err && err.message ? err.message : String(err)) });
    }
};
