const { put } = require('@vercel/blob');

/* Uploads a base64/text payload to Vercel Blob and returns its public URL.
   Runs entirely server-side now -- no secret handshake needed since this
   code is never shipped to the browser (unlike the old client-side
   uploadPdfToBlob() + PDF_RELAY_SECRET design, which leaked both the
   secret and the Zapier webhook URL into the public GitHub repo and into
   anyone's browser devtools on the live site). */
async function uploadBlob(content, filename, contentType) {
     try {
            if (!content) return null;
            var buf;
            if (contentType === 'application/pdf') {
                     var b64 = content;
                     if (b64.slice(0, 5) === 'data:') {
                                var comma = b64.indexOf(',');
                                if (comma >= 0) b64 = b64.slice(comma + 1);
                     }
                     buf = Buffer.from(b64, 'base64');
            } else {
                     buf = Buffer.from(content, 'utf8');
            }
            if (!buf.length) return null;

       var safeName = (filename || 'file').toString().replace(/[^a-zA-Z0-9._-]/g, '_');
            var blob = await put('onboarding-uploads/' + safeName, buf, {
                     access: 'public',
                     contentType: contentType,
                     addRandomSuffix: true,
            });
            return blob.url;
     } catch (err) {
            console.error('Blob upload failed for ' + filename, err);
            return null;
     }
}

/* Mirrors the required-field checks in index.html's getSubmitBlockers().
   The browser already blocks the "Submit" button from advancing past this
   step when any of these are missing -- that part of the flow was already
   working correctly. This is the missing second layer: without it, nothing
   stopped an incomplete or empty submission sent directly to this endpoint
   (bypassing the browser entirely) from going through to Zapier/the
   onboarding team. Keep this list in sync with getSubmitBlockers() if that
   function's required fields ever change. */
function getServerSideBlockers(body) {
     var errors = [];
     var s = body || {};

  if (!(s.companyName || '').toString().trim()) errors.push('Company name is missing.');
     if (!s.portLocal && !s.portTF && !s.getNew) errors.push('No phone numbers selected -- choose at least one: port existing numbers or get new ones.');

  if (s.portLocal) {
         var localList = (s.numbers || []).filter(function (n) { return n && n.type === 'port-local'; });
         if (!localList.length) errors.push('"Transfer my existing local numbers" was checked but no numbers to port were entered.');
         if (!(s.localCarrier || '').toString().trim()) errors.push('Local port: current carrier is missing.');
         if (!(s.localAcctNum || '').toString().trim()) errors.push('Local port: account number is missing.');
         if (!s.loaSigDrawn) errors.push('The LOA has not been signed.');
  }

  if (s.portTF) {
         var tfList = (s.numbers || []).filter(function (n) { return n && n.type === 'port-tf'; });
         if (!tfList.length) errors.push('"Transfer my toll-free numbers" was checked but no numbers to port were entered.');
         if (!(s.respStreet || '').toString().trim() || !(s.respCity || '').toString().trim()) errors.push('Toll-free authorization address is incomplete.');
         if (!s.respSigDrawn) errors.push('The Resporg form has not been signed.');
  }

  if (!(s.e911Street || '').toString().trim() || !(s.e911City || '').toString().trim() || !(s.e911State || '').toString().trim() || !(s.e911Zip || '').toString().trim()) {
         errors.push('E911 address is incomplete.');
  }

  var namedUsers = (s.users || []).filter(function (u) { return u && ((u.fn || '').toString().trim() || (u.ln || '').toString().trim()); });
     if (!namedUsers.length) errors.push('No team members have names entered.');

  return errors;
}

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

       var blockers = getServerSideBlockers(body);
            if (blockers.length) {
                     res.status(400).json({ error: 'Submission is incomplete', blockers: blockers });
                     return;
            }

       var zapierUrl = process.env.ZAPIER_WEBHOOK_URL;
            if (!zapierUrl) {
                     res.status(500).json({ error: 'Server not configured (missing ZAPIER_WEBHOOK_URL)' });
                     return;
            }

       var payload = Object.assign({}, body);

       // Upload the two signed PDFs (if present) to blob storage server-side.
       if (payload.loaPdfBase64) {
                var loaUrl = await uploadBlob(payload.loaPdfBase64, (payload.loaPdfFilename || 'loa.pdf'), 'application/pdf');
                if (loaUrl) payload.loaPdfUrl = loaUrl;
       }
            if (payload.respPdfBase64) {
                     var respUrl = await uploadBlob(payload.respPdfBase64, (payload.respPdfFilename || 'resporg.pdf'), 'application/pdf');
                     if (respUrl) payload.respPdfUrl = respUrl;
            }
            // Upload the PBX/user-import CSV as an actual downloadable .csv file too,
       // so it can be attached as a real file (Drive/Gmail) instead of only
       // being readable as plain text inside the webhook payload.
       if (payload.pbxImportCsv) {
                var csvName = ((payload.companyName || 'unicom') + '-pbx-import.csv').replace(/\s+/g, '_');
                var csvUrl = await uploadBlob(payload.pbxImportCsv, csvName, 'text/csv');
                if (csvUrl) payload.pbxImportCsvUrl = csvUrl;
       }

       var zapResp = await fetch(zapierUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
       });

       if (!zapResp.ok) {
                res.status(502).json({ error: 'Zapier webhook returned ' + zapResp.status });
                return;
       }

       res.status(200).json({ ok: true });
     } catch (err) {
            res.status(500).json({ error: 'Submit error: ' + (err && err.message ? err.message : String(err)) });
     }
};
