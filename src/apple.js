import { chromium } from 'playwright';
import { parseCatalog } from './parse.js';

// One row per kind of device: its store path, the page that links to every
// model, and what those links look like. Model pages can use either layout
// parseCatalog reads.
const CATEGORIES = [
  { id: 'buy-iphone', index: 'shop/buy-iphone', link: /shop\/buy-iphone\/([a-z0-9-]+)/g },
  { id: 'buy-ipad', index: 'shop/buy-ipad', link: /shop\/buy-ipad\/([a-z0-9-]+)/g },
  { id: 'buy-mac', index: 'shop/buy-mac', link: /shop\/buy-mac\/([a-z0-9-]+)/g },
  { id: 'buy-airpods', index: 'airpods/', link: /shop\/goto\/buy_airpods\/([a-z0-9_]+)/g },
];
// Countries the UI offers. Other Apple Store country paths (`uk`, `au`, ...) work from COUNTRY in .env.
export const COUNTRIES = {
  ca: { name: 'Canada', locale: 'en-CA', postal: 'Postal code' },
  us: { name: 'United States', locale: 'en-US', postal: 'ZIP code' },
};

export function normalizeCountry(value) {
  const country = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(country)) throw new Error(`unsupported country ${value}`);
  return country;
}

const PRODUCT_ID = new RegExp(`^(${CATEGORIES.map((c) => c.id).join('|')})/[a-z0-9-]+$`);

export function normalizeProduct(value) {
  let id = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!id.includes('/')) id = `buy-iphone/${id}`;
  if (!PRODUCT_ID.test(id)) throw new Error(`unsupported product ${value}`);
  return id;
}

const PLATFORM_UA = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
};

// Headless Chromium advertises "HeadlessChrome", which Apple's shield rejects.
function userAgentFor(browserVersion) {
  const major = browserVersion.split('.')[0];
  const platform = PLATFORM_UA[process.platform] ?? PLATFORM_UA.linux;
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export class AppleStore {
  constructor({ country, product, headless = true, log = () => {} } = {}) {
    this.country = country;
    this.product = product;
    this.headless = headless;
    this.log = log;
  }

  get locale() {
    return COUNTRIES[this.country]?.locale ?? 'en-US';
  }

  get origin() {
    return 'https://www.apple.com';
  }

  get shopPath() {
    return this.country === 'us' ? '/shop' : `/${this.country}/shop`;
  }

  get productUrl() {
    return this.urlFor(this.product);
  }

  urlFor(product) {
    return `${this.origin}${this.shopPath}/${normalizeProduct(product)}`;
  }

  async open() {
    this.browser = await chromium.launch({
      headless: this.headless,
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    await this.newSession();
  }

  async newSession() {
    await this.context?.close().catch(() => {});
    this.context = await this.browser.newContext({ userAgent: userAgentFor(this.browser.version()), locale: this.locale });
    this.page = await this.context.newPage();
  }

  async loadProductPage() {
    const res = await this.page.goto(this.productUrl, { waitUntil: 'load', timeout: 60_000 });
    if (!res || res.status() >= 400) {
      throw new Error(`Product page ${this.productUrl} returned ${res?.status()}`);
    }
    this.html = await this.page.content();
  }

  async fetchPage(product = this.product) {
    const url = this.urlFor(product);
    const res = await fetch(url, { headers: { 'User-Agent': userAgentFor('130'), 'Accept-Language': this.locale }, redirect: 'manual' });
    if (res.status !== 200) throw new Error(`${url} returned ${res.status}`);
    return res.text();
  }

  async findProductIds() {
    const get = async (path) => {
      const res = await fetch(`${this.origin}${path}`, { headers: { 'User-Agent': userAgentFor('130') } });
      return res.ok ? res.text() : '';
    };
    const country = this.country === 'us' ? '' : `/${this.country}`;
    const pages = await Promise.all(CATEGORIES.map((c) => get(`${country}/${c.index}`)));
    const ids = new Set();
    CATEGORIES.forEach((c, i) => {
      for (const m of pages[i].matchAll(c.link)) ids.add(`${c.id}/${m[1].replace(/_/g, '-')}`);
    });
    return [...ids];
  }

  // Only pages with a product selector we can read make it into the menu.
  async listProducts() {
    const found = await Promise.all(
      (await this.findProductIds()).map(async (slug) => {
        const catalog = await this.fetchPage(slug).then(parseCatalog, () => null);
        if (!catalog) return null;
        return { slug, name: catalog.title ?? productName(slug), image: catalog.models[0]?.image ?? null };
      }),
    );
    const order = (slug) => CATEGORIES.findIndex((c) => slug.startsWith(`${c.id}/`));
    return found.filter(Boolean).sort((a, b) => order(a.slug) - order(b.slug) || a.name.localeCompare(b.name, 'en', { numeric: true }));
  }

  async close() {
    await this.browser?.close();
  }

  async fetchFulfillment(partNumbers, location) {
    const params = new URLSearchParams({ fae: 'true', pl: 'true', 'mts.0': 'regular', location });
    partNumbers.forEach((pn, i) => params.set(`parts.${i}`, pn));
    const path = `${this.shopPath}/fulfillment-messages?${params}`;

    // Apple's bot shield issues a proof-of-work challenge from the product page;
    // requests return 541 until the page script has solved it and set its cookie.
    const deadline = Date.now() + 75_000;
    let retries = 0;
    for (;;) {
      const { status, text } = await this.page.evaluate(async (url) => {
        const r = await fetch(url, { headers: { 'x-aos-ui-fetch-call-1': '1' } });
        return { status: r.status, text: await r.text() };
      }, path);
      if (status === 200) return JSON.parse(text);
      if (Date.now() > deadline) throw new Error(`fulfillment-messages kept returning ${status}`);
      if (Date.now() > deadline - (2 - retries) * 25_000) {
        // First retry reloads the page; second starts over with fresh cookies.
        this.log(`fulfillment-messages returned ${status}; ${retries === 0 ? 'reloading page' : 'starting a fresh session'}`);
        if (retries === 1) await this.newSession();
        await this.loadProductPage();
        retries++;
      }
      await this.page.waitForTimeout(2_000);
    }
  }
}

const WORDS = { iphone: 'iPhone', ipad: 'iPad', airpods: 'AirPods', mini: 'mini' };

export function productName(slug) {
  return slug
    .split('/')
    .pop()
    .split('-')
    .map((w) => WORDS[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
