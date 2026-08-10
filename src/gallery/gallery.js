const grid = document.querySelector('#galleryGrid');
const lightbox = document.querySelector('#lightbox');
const lightboxImage = lightbox.querySelector('img');
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
  lightboxImage.src = withToken(item.mediaUrl);
  lightboxDownload.href = withToken(item.downloadUrl);
  if (!lightbox.open) lightbox.showModal();
}

function render(session) {
  document.querySelector('#sessionDate').textContent = formatDate(session.createdAt, { dateStyle: 'full', timeStyle: 'short' });
  document.querySelector('#expiryDate').textContent = `Link còn hiệu lực đến ${formatDate(session.expiresAt, { dateStyle: 'medium' })}`;
  items = session.items;
  if (!items.length) {
    grid.innerHTML = '<div class="empty-card"><h3>Ảnh đang được hoàn thiện</h3><p>Hãy tải lại trang sau ít phút nhé.</p></div>';
    return;
  }
  grid.replaceChildren();
  items.forEach((item, index) => {
    const article = document.createElement('article');
    article.className = 'photo-card';
    const button = document.createElement('button');
    button.className = 'photo-button';
    button.type = 'button';
    button.setAttribute('aria-label', `Xem ${item.label}`);
    const image = document.createElement('img');
    image.src = withToken(item.mediaUrl);
    image.alt = item.label;
    image.loading = index < 2 ? 'eager' : 'lazy';
    button.append(image);
    button.addEventListener('click', () => openLightbox(index));
    const caption = document.createElement('div');
    caption.className = 'photo-caption';
    const label = document.createElement('span');
    label.textContent = item.label;
    const download = document.createElement('a');
    download.href = withToken(item.downloadUrl);
    download.textContent = 'TẢI BẢN GỐC ↓';
    caption.append(label, download);
    article.append(button, caption);
    grid.append(article);
  });
}

async function load() {
  try {
    const response = await fetch(`/api/public/sessions/${encodeURIComponent(sessionId)}?t=${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 410 ? 'Bộ ảnh đã hết hạn.' : 'Không thể mở bộ ảnh này.');
    render(await response.json());
  } catch (error) {
    grid.innerHTML = `<div class="error-card"><h3>Chưa mở được gallery</h3><p>${error.message}</p></div>`;
  }
}

lightbox.querySelector('.close').addEventListener('click', () => lightbox.close());
lightbox.querySelector('.previous').addEventListener('click', () => openLightbox(activeIndex - 1));
lightbox.querySelector('.next').addEventListener('click', () => openLightbox(activeIndex + 1));
lightbox.addEventListener('click', (event) => { if (event.target === lightbox) lightbox.close(); });
document.addEventListener('keydown', (event) => {
  if (!lightbox.open) return;
  if (event.key === 'ArrowLeft') openLightbox(activeIndex - 1);
  if (event.key === 'ArrowRight') openLightbox(activeIndex + 1);
});

load();
