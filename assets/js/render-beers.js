document.addEventListener('DOMContentLoaded', () => {
  fetch('/data/beers.json')
    .then(res => res.json())
    .then(data => {
      // Tap List
      const taplistCarousel = document.getElementById('taplist-carousel');
      taplistCarousel.innerHTML = '';
      data.taplist.forEach(beer => {
        const item = document.createElement('div');
        item.className = 'carousel-item';
        item.innerHTML = `
          <a href="${beer.url}" target="_blank">
            <img src="${beer.image}" alt="${beer.name}">
            <div>${beer.name}</div>
          </a>
        `;
        taplistCarousel.appendChild(item);
      });

      // To Go List
      const togoCarousel = document.getElementById('togo-carousel');
      togoCarousel.innerHTML = '';
      data.togo.forEach(beer => {
        const item = document.createElement('div');
        item.className = 'carousel-item';
        item.innerHTML = `
          <a href="${beer.url}" target="_blank">
            <img src="${beer.image}" alt="${beer.name}">
            <div>${beer.name}</div>
          </a>
        `;
        togoCarousel.appendChild(item);
      });
    })
    .catch(err => console.error('Error loading beers.json:', err));
});
