/**
 * akron-pulse-embed.js — optional auto-height helper for the Akron Pulse
 * white-label embed.
 *
 * Drop this <script> on any page that hosts an Akron Pulse embed iframe and
 * the iframe will grow/shrink to fit its content (no inner scrollbar) as the
 * visitor filters, paginates, or opens an event. Without it the embed still
 * works — it just keeps whatever fixed height you set on the iframe.
 *
 * Usage:
 *   <iframe
 *     src="https://akronpulse.app/embed?theme=civic-teal&categories=music"
 *     data-akron-pulse-embed
 *     style="width:100%;border:0;height:900px"
 *     title="Upcoming Events"></iframe>
 *   <script src="https://akronpulse.app/akron-pulse-embed.js" async></script>
 *
 * The script is dependency-free, self-executing, and safe to load async or
 * defer. It only ever adjusts the height of iframes carrying the
 * `data-akron-pulse-embed` attribute, and only in response to height
 * messages whose source window matches one of those iframes.
 */
(function () {
  'use strict'

  var MESSAGE_TYPE = 'akron-pulse-embed:height'

  function embedFrames() {
    return Array.prototype.slice.call(
      document.querySelectorAll('iframe[data-akron-pulse-embed]')
    )
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || data.type !== MESSAGE_TYPE) return
    var height = Number(data.height)
    if (!height || height < 0) return

    // Only resize the iframe the message actually came from — never trust a
    // height message to target an arbitrary frame.
    var frames = embedFrames()
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === event.source) {
        frames[i].style.height = height + 'px'
        break
      }
    }
  })
})()
