const grid = document.querySelector('#galleryGrid');
const lightbox = document.querySelector('#lightbox');
const lightboxImage = lightbox.querySelector('img');
const lightboxVideo = lightbox.querySelector('video');
const lightboxDownload = lightbox.querySelector('.lightbox-download');
const sessionId = location.pathname.split('/').filter(Boolean).at(-1) || '';
const token = new URLSearchParams(location.search).get('t') || '';
let items = [];
let activeIndex = 0;

const withToken = (url) => {
  const value = new URL(url, location.origin);
  value.searchParams.set('t', token);
  return `${value.pathname}${value.search}`;
};

const formatDate = (value, options) => new Intl.DateTimeFormat('vi-VN', options).format(new Date(value));

function openLightbox(index) {
  activeIndex = (index + items.length) % items.length;
  const item = items[activeIndex];
  const isVideo = item.mediaType === 'video' || item.kind?.startsWith('video');
  lightboxImage.hidden = isVideo;
  lightboxVideo.hidden = !isVideo;
  lightboxVideo.pause();
  if (isVideo) {
    lightboxImage.removeAttribute('src');
    lightboxVideo.src = withToken(item.mediaUrl);
    lightboxVideo.play().catch(() => {});
  } else {
    lightboxVideo.removeAttribute('src');
    lightboxImage.src = withToken(item.mediaUrl);
  }
  lightboxDownload.href = withToken(item.downloadUrl);
  if (!lightbox.open) lightbox.showModal();
}

function render(session) {
  document.querySelector('#sessionDate').textContent = formatDate(session.createdAt, { dateStyle: 'full', timeStyle: 'short' });
  document.querySelector('#expiryDate').textContent = `Album mở đến ${formatDate(session.expiresAt, { dateStyle: 'medium' })} nè~`;
  items = session.items;
  if (!items.length) {
    grid.innerHTML = '<div class="empty-card"><h3>Ảnh đang trên đường đến nè~</h3><p>Chạm đang gói ghém album cho bạn, ghé lại sau một chút nhé.</p></div>';
    return;
  }
  grid.replaceChildren();
  items.forEach((item, index) => {
    const article = document.createElement('article');
    article.className = 'photo-card';

    const button = document.createElement('button');
    button.className = 'photo-button';
    button.type = 'button';

    const isVideo = item.mediaType === 'video' || item.kind?.startsWith('video');
    const displayLabel = isVideo
      ? 'Video hậu trường'
      : item.kind === 'photo-strip' ? 'Ảnh thành phẩm' : item.kind === 'photo-processed' ? 'Ảnh đã chỉnh màu' : 'Ảnh gốc';

    button.setAttribute('aria-label', `Xem ${displayLabel}`);
    button.classList.toggle('video', isVideo);

    // Badge label on top-left of card
    const badge = document.createElement('span');
    badge.className = 'photo-badge';
    badge.textContent = displayLabel;

    const media = document.createElement(isVideo ? 'video' : 'img');
    media.src = withToken(item.mediaUrl);
    media.setAttribute('aria-label', displayLabel);
    if (isVideo) {
      media.muted = true;
      media.loop = true;
      media.autoplay = true;
      media.playsInline = true;
      media.preload = 'metadata';
    } else {
      media.alt = displayLabel;
      media.loading = index < 2 ? 'eager' : 'lazy';
    }

    button.append(media);
    button.addEventListener('click', () => openLightbox(index));

    // Download overlay link on bottom-right of card
    const downloadLink = document.createElement('a');
    downloadLink.className = 'photo-download-overlay';
    downloadLink.href = withToken(item.downloadUrl);
    downloadLink.textContent = isVideo ? 'TẢI VIDEO ↓' : 'TẢI VỀ ↓';

    article.append(badge, button, downloadLink);
    grid.append(article);
  });
}

async function load() {
  try {
    const response = await fetch(`/api/public/sessions/${encodeURIComponent(sessionId)}?t=${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 410 ? 'Album này đã đóng rồi nè.' : 'Chưa mở được album lúc này.');
    render(await response.json());
  } catch (error) {
    grid.innerHTML = `<div class="error-card"><h3>Oops, chưa mở được album</h3><p>${error.message}</p></div>`;
  }
}

lightbox.querySelector('.close').addEventListener('click', () => { lightboxVideo.pause(); lightbox.close(); });
lightbox.querySelector('.previous').addEventListener('click', () => openLightbox(activeIndex - 1));
lightbox.querySelector('.next').addEventListener('click', () => openLightbox(activeIndex + 1));
lightbox.addEventListener('click', (event) => { if (event.target === lightbox) { lightboxVideo.pause(); lightbox.close(); } });
document.addEventListener('keydown', (event) => {
  if (!lightbox.open) return;
  if (event.key === 'ArrowLeft') openLightbox(activeIndex - 1);
  if (event.key === 'ArrowRight') openLightbox(activeIndex + 1);
});

load();
