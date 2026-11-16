window.__pwned = 'script from foreign origin ran with host privileges; token=' + localStorage.getItem('jwt_token');
customElements.define('zb-personalization-admin', class extends HTMLElement { connectedCallback(){ this.textContent='foreign element'; } });
