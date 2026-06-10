/**
 * Akron Pulse — Intake OCR Bridge
 * ================================
 * Runs inside the intake@akronpulse.com Google account (Apps Script).
 *
 * Problem: the Gmail MCP connector used by the nightly intake task cannot
 * download attachments, so image-only event flyers are invisible to it.
 *
 * What this does, every 10 minutes:
 *   1. Finds unread inbox messages with image/PDF attachments that have not
 *      been OCR'd yet (no "ocr-done" label).
 *   2. Runs each attachment through Google Drive's built-in OCR
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
 *   - Originals get label "ocr-done" and are marked read
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

      if (attachments.length === 0) return; // text-only email: nightly task handles it

      var ocrSections = attachments.map(function (a, i) {
        var text = '';
        try {
          text = ocrBlob_(a.copyBlob(), a.getName() || 'attachment-' + (i + 1));
        } catch (e) {
          text = '[OCR FAILED: ' + e.message + ']';
        }
        return (
          '--- ATTACHMENT ' + (i + 1) + ' of ' + attachments.length +
          ' (' + (a.getName() || 'unnamed') + ', ' + a.getContentType() + ') ---\n' +
          (text.trim() || '[No text detected in image]')
        );
      });

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
    });
  });
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
