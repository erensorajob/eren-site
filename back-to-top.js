(() => {
    const button = document.querySelector('.back-to-top');
    if (!button) return;

    const showAfter = 360;
    const updateVisibility = () => {
        button.classList.toggle('is-visible', window.scrollY > showAfter);
    };

    window.addEventListener('scroll', updateVisibility, { passive: true });
    updateVisibility();

    button.addEventListener('click', () => {
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
    });
})();
