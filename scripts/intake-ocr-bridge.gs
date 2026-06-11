/**
 * Akron Pulse — Intake OCR Bridge
 * ================================
 * Runs inside the intake@akronpulse.com Google account (Apps Script).
 *
 * Problem: the Gmail MCP connector used by the nightly intake task cannot
 * download attachments, so image-only event flyers are invisible to it.
 *
 * What this does, every 10 minutes:
 *   1. Finds unread inbox messages that have not been OCR'd yet (no "ocr-done"
 *      label) and carry image/PDF attachments OR large remote images in the
 *      HTML body (newsletter platforms like Constant Contact host flyers at a
 *      URL instead of attaching them — they are invisible to getAttachments()).
 *   2. Runs each image through Google Drive's built-in OCR
 *      (image -> temporary Google Doc -> extract text -> delete temp Doc).
 *   3. Sends a new email to intake@akronpulse.com with subject "OCR: <orig>"
 *      containing the original metadata, original body text, and the OCR text.
 *      The nightly task picks this up as a normal text email.
 *   4. Labels the original "ocr-done" and marks it read so the nightly task
 *      does not double-process it (its query is is:unread).
 *
 * SETUP (one time, ~15 minutes):
 *   1. While signed in as intake@akronpulse.com, go to https://script.google.com
 *      and create a new project named "Intake OCR Bridge".
 *   2. Replace the default Code.gs contents with this file.
 *   3. In the left sidebar, click Services (+), find "Drive API", leave
 *      version at v2, and click Add.
 *   4. Run the function `processImageEmails` once from the toolbar and grant
 *      the permission prompts (Gmail + Drive).
 *   5. In the left sidebar, click Triggers (alarm clock icon) > Add Trigger:
 *      function `processImageEmails`, event source "Time-driven",
 *      type "Minutes timer", every 10 minutes. Save.
 *
 * Contract with the nightly task (keep in sync with the scheduled-task prompt):
 *   - OCR output emails have subject prefix "OCR: "
 *   - Originals get label "ocr-done" and are marked read ONLY after a
 *     successful send; on OCR failure the original stays unread and the next
 *     10-minute run retries it
 *   - Google's OCR endpoint rate-limits sporadically; each attachment is
 *     retried in-run with backoff, and the message is retried across runs up
 *     to GIVE_UP_AFTER_ATTEMPTS times (~5 hours) before an email with
 *     "[OCR FAILED" markers is sent so the nightly task can flag it
 *   - Attachments smaller than MIN_ATTACHMENT_BYTES are ignored (logos,
 *     signatures, tracking pixels)
 */

var OCR_LABEL_NAME = 'ocr-done';
var INTAKE_ADDRESS = 'intake@akronpulse.com';
var SUBJECT_PREFIX = 'OCR: ';
var MIN_ATTACHMENT_BYTES = 30 * 1024; // skip logos/signatures/pixels
var OCR_MIME_TYPES = [
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif',
  'image/webp', 'image/heic', 'image/heif', 'application/pdf'
];
var IN_RUN_OCR_TRIES = 4;        // per-attachment tries within one run (3s/9s/27s backoff)
var GIVE_UP_AFTER_ATTEMPTS = 30; // cross-run retries (~5 hours at a 10-min trigger)
var MAX_REMOTE_IMAGES = 5;       // cap remote-image OCR per message (quota protection)

function processImageEmails() {
  var label = getOrCreateLabel_(OCR_LABEL_NAME);
  // has:attachment misses some inline images, so search broadly and filter.
  var threads = GmailApp.search(
    'in:inbox is:unread -label:' + OCR_LABEL_NAME + ' -subject:"' + SUBJECT_PREFIX.trim() + '"'
  );

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      if (!message.isUnread()) return;
      // Never reprocess our own OCR output (loop guard).
      if (message.getSubject().indexOf(SUBJECT_PREFIX.trim()) === 0) return;

      var attachments = message
        .getAttachments({ includeInlineImages: true, includeAttachments: true })
        .filter(function (a) {
          return (
            OCR_MIME_TYPES.indexOf(String(a.getContentType()).toLowerCase()) !== -1 &&
            a.getSize() >= MIN_ATTACHMENT_BYTES
          );
        });

      // Newsletter flyers are usually hosted remotely (<img src>), not attached.
      var remoteImages = fetchRemoteImages_(message.getBody());

      if (attachments.length === 0 && remoteImages.length === 0) return; // text-only: nightly task handles it

      var anyFailed = false;
      var blobs = attachments
        .map(function (a, i) {
          return { blob: a.copyBlob(), label: (a.getName() || 'unnamed') + ', ' + a.getContentType() + ', attached' };
        })
        .concat(remoteImages.map(function (r) {
          return { blob: r.blob, label: r.url + ', remote' };
        }));

      var ocrSections = blobs.map(function (item, i) {
        var text = '';
        try {
          text = ocrWithBackoff_(item.blob, 'image-' + (i + 1));
        } catch (e) {
          anyFailed = true;
          text = '[OCR FAILED: ' + e.message + ']';
        }
        return (
          '--- IMAGE ' + (i + 1) + ' of ' + blobs.length + ' (' + item.label + ') ---\n' +
          (text.trim() || '[No text detected in image]')
        );
      });

      // On failure, leave the original untouched so the next run retries it,
      // unless we've been failing for ~5 hours — then send what we have so the
      // nightly task can flag it for manual attention.
      if (anyFailed && bumpAttempts_(message.getId()) < GIVE_UP_AFTER_ATTEMPTS) {
        return;
      }

      var body =
        'Automated OCR extraction by the Intake OCR Bridge.\n\n' +
        '== ORIGINAL MESSAGE ==\n' +
        'From: ' + message.getFrom() + '\n' +
        'Date: ' + message.getDate() + '\n' +
        'Subject: ' + message.getSubject() + '\n\n' +
        '== ORIGINAL BODY TEXT ==\n' +
        (message.getPlainBody() || '').trim().slice(0, 5000) + '\n\n' +
        '== OCR TEXT FROM ATTACHMENTS ==\n' +
        ocrSections.join('\n\n');

      GmailApp.sendEmail(INTAKE_ADDRESS, SUBJECT_PREFIX + message.getSubject(), body);

      thread.addLabel(label);
      message.markRead();
      clearAttempts_(message.getId());
    });
  });
}

/**
 * Google's OCR endpoint rate-limits sporadically ("User rate limit exceeded
 * for OCR"), usually transiently. Retry within the run using exponential
 * backoff before giving up and letting the cross-run retry take over.
 */
function ocrWithBackoff_(blob, name) {
  var waitMs = 3000;
  for (var attempt = 1; ; attempt++) {
    try {
      return ocrBlob_(blob, name);
    } catch (e) {
      if (attempt >= IN_RUN_OCR_TRIES) throw e;
      Utilities.sleep(waitMs);
      waitMs *= 3;
    }
  }
}

function bumpAttempts_(messageId) {
  var props = PropertiesService.getScriptProperties();
  var key = 'ocr-attempts-' + messageId;
  var n = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(n));
  return n;
}

function clearAttempts_(messageId) {
  PropertiesService.getScriptProperties().deleteProperty('ocr-attempts-' + messageId);
}

/**
 * OCR a blob via Drive: upload as a converted Google Doc with ocr=true,
 * read the Doc text, then permanently delete the temp Doc.
 * Requires the Drive API (v2) advanced service to be enabled.
 */
function ocrBlob_(blob, name) {
  var resource = { title: '[temp-ocr] ' + name };
  var file = Drive.Files.insert(resource, blob, { ocr: true, ocrLanguage: 'en' });
  try {
    var text = DocumentApp.openById(file.id).getBody().getText();
    return text;
  } finally {
    Drive.Files.remove(file.id);
  }
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

/**
 * Extract large remote images referenced in the HTML body and download them
 * for OCR. Newsletter platforms (Constant Contact, Mailchimp) host flyer
 * images at a URL rather than attaching them. Filters out platform chrome
 * (spacers, social icons, footer logos, tracking pixels) by URL pattern, then
 * by downloaded size (MIN_ATTACHMENT_BYTES). Caps at MAX_REMOTE_IMAGES.
 * Fetch failures are skipped silently — they don't count as OCR failures.
 */
function fetchRemoteImages_(html) {
  if (!html) return [];
  var results = [];
  var seen = {};
  var re = /<img[^>]+src=["']([^"']+)["']/gi;
  var m;
  while ((m = re.exec(html)) !== null && results.length < MAX_REMOTE_IMAGES) {
    var url = m[1].replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(url)) continue;                                  // skip cid:/data: refs (handled as attachments)
    if (seen[url]) continue;
    seen[url] = true;
    if (/imgssl\.constantcontact\.com\/letters\//i.test(url)) continue;        // CC spacers/icons/footer chrome
    if (/SocialIcons|referralLogos|\/on\.jsp|\.gif(\?|$)/i.test(url)) continue; // icons + tracking pixels
    try {
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
      if (resp.getResponseCode() !== 200) continue;
      var blob = resp.getBlob();
      var type = String(blob.getContentType() || '').toLowerCase();
      if (type.indexOf('image/') !== 0 && type !== 'application/pdf') continue;
      if (blob.getBytes().length < MIN_ATTACHMENT_BYTES) continue;
      results.push({ url: url.split('?')[0], blob: blob });
    } catch (e) {
      // Unreachable image — skip; body text still goes to the nightly task.
    }
  }
  return results;
}
