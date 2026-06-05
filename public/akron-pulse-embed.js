/**
 * akron-pulse-embed.js — optional helper for the Akron Pulse white-label embed.
 *
 * Drop this <script> on any page that hosts an Akron Pulse embed iframe and it
 * does two things, both keyed on iframes carrying the `data-akron-pulse-embed`
 * attribute:
 *
 *   1. AUTO-HEIGHT — grows/shrinks the iframe to fit its content (no inner
 *      scrollbar) as the visitor filters, paginates, or opens an event.
 *
 *   2. VIEWPORT RELAY — tells the iframe which slice of itself is currently
 *      on-screen. A tall auto-height iframe has no scroll of its own, so a
 *      `position: fixed` modal inside it would otherwise pin to the iframe's
 *      full box and land off-screen. With this relay the embed positions its
 *      filter tray / dialogs in the band the visitor is actually looking at.
 *
 * Without the script the embed still works — the iframe just keeps the fixed
 * height you set, and modals fall back to the top of the frame.
 *
 * Usage:
 *   <iframe
 *     src="https://akronpulse.com/embed?theme=civic-teal&categories=music"
 *     data-akron-pulse-embed
 *     style="width:100%;border:0;height:900px"
 *     title="Upcoming Events"></iframe>
 *   <script src="https://akronpulse.com/akron-pulse-embed.js" async></script>
 *
 * Dependency-free, self-executing, safe to load async or defer.
 */
(function () {
  'use strict'

  var HEIGHT_TYPE   = 'akron-pulse-embed:height'    // iframe → parent
  var VIEWPORT_TYPE = 'akron-pulse-embed:viewport'  // parent → iframe
  var REQUEST_TYPE  = 'akron-pulse-embed:request'   // iframe → parent

  function embedFrames() {
    return Array.prototype.slice.call(
      document.querySelectorAll('iframe[data-akron-pulse-embed]')
    )
  }

  // Compute the visible slice of `frame` in the iframe's own coordinate space
  // and post it so fixed overlays inside can sit in the on-screen band.
  function postViewport(frame) {
    if (!frame || !frame.contentWindow) return
    var rect = frame.getBoundingClientRect()
    var vh = window.innerHeight || document.documentElement.clientHeight
    var top = Math.max(0, -rect.top)                       // px scrolled past iframe top
    var height = Math.max(0, Math.min(vh, rect.bottom) - Math.max(0, rect.top))
    frame.contentWindow.postMessage(
      { type: VIEWPORT_TYPE, top: Math.round(top), height: Math.round(height) },
      '*'
    )
  }

  function postViewportAll() {
    embedFrames().forEach(postViewport)
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data) return

    // Auto-height: resize the frame the message actually came from.
    if (data.type === HEIGHT_TYPE) {
      var height = Number(data.height)
      if (!height || height < 0) return
      var frames = embedFrames()
      for (var i = 0; i < frames.length; i++) {
        if (frames[i].contentWindow === event.source) {
          frames[i].style.height = height + 'px'
          // Height changed → the visible band shifted; refresh it.
          postViewport(frames[i])
          break
        }
      }
      return
    }

    // The embed asks for its viewport (e.g. when it opens a modal).
    if (data.type === REQUEST_TYPE) {
      var fs = embedFrames()
      for (var j = 0; j < fs.length; j++) {
        if (fs[j].contentWindow === event.source) {
          postViewport(fs[j])
          break
        }
      }
    }
  })

  // Keep the viewport band fresh as the host page scrolls / resizes.
  window.addEventListener('scroll', postViewportAll, { passive: true })
  window.addEventListener('resize', postViewportAll)
  window.addEventListener('load', postViewportAll)
  // First paint, in case the iframe is already in view before any scroll.
  postViewportAll()
})()
