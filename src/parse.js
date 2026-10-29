const STORE_AVAILABLE = new Set(['available']);
const KM_PER_MILE = 1.609344;

export function parseProducts(html) {
  const match = html.match(/<script type=application\/json id=metrics>([\s\S]*?)<\/script>/)
    ?? html.match(/<script[^>]*id="?metrics"?[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }
  const products = data?.data?.products ?? [];
  return uniqueParts(products.filter((p) => p.partNumber && p.name))
    .map((p) => ({ partNumber: p.partNumber, name: p.name, price: p.price?.fullPrice ?? null }))
    .sort((a, b) => storageGb(a.name) - storageGb(b.name) || a.name.localeCompare(b.name));
}

function storageGb(name) {
  const m = name.match(/(\d+)\s*(GB|TB)/i);
  if (!m) return 0;
  return Number(m[1]) * (m[2].toUpperCase() === 'TB' ? 1024 : 1);
}

export function shortPickupQuote(quote) {
  if (!quote) return '';
  const date = quote.match(/\b(\d{1,2}[./]\d{1,2})\b/);
  if (/check back/i.test(quote) && date) return `Pickup ${date[1]}`;
  if (/unavailable|not available/i.test(quote)) return 'No pickup';
  return quote;
}

export function selectProducts(products, filter) {
  const terms = (filter ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (terms.length === 0 || terms.includes('all')) return products;
  return products.filter((p) => {
    const haystack = `${p.partNumber} ${p.name}`.toLowerCase();
    return terms.some((term) => term.split(/\s+/).every((word) => haystack.includes(word)));
  });
}

export function parseFulfillment(json, { maxDistanceKm = Infinity } = {}) {
  const content = json?.body?.content;
  if (!content) throw new Error('Unexpected fulfillment response shape');

  const pickup = [];
  for (const store of content.pickupMessage?.stores ?? []) {
    // US stores report miles; MAX_DISTANCE_KM is always kilometres.
    const miles = /\bmi\b/.test(store.storeDistanceWithUnit ?? '');
    const distanceKm = Number(store.storedistance) * (miles ? KM_PER_MILE : 1);
    if (Number.isFinite(distanceKm) && distanceKm > maxDistanceKm) continue;
    for (const [partNumber, part] of Object.entries(store.partsAvailability ?? {})) {
      pickup.push({
        partNumber,
        storeNumber: store.storeNumber,
        storeName: store.storeName,
        city: store.city,
        distance: store.storeDistanceWithUnit ?? `${distanceKm} km`,
        distanceKm,
        available: STORE_AVAILABLE.has(part.pickupDisplay),
        quote: stripHtml(part.pickupSearchQuote ?? part.messageTypes?.regular?.storePickupQuote ?? ''),
        title: part.messageTypes?.regular?.storePickupProductTitle ?? null,
      });
    }
  }

  const delivery = [];
  for (const [partNumber, entry] of Object.entries(content.deliveryMessage ?? {})) {
    const msg = entry?.regular;
    if (!msg || typeof msg !== 'object') continue;
    const courierText = stripHtml(msg.stickyMessageIDL ?? '');
    delivery.push({
      partNumber,
      courierAvailable: msg.idl === true && !/unavailable/i.test(courierText),
      courierText,
      shipText: stripHtml(msg.stickyMessageSTH ?? msg.deliveryOptionMessages?.[0]?.displayName ?? ''),
      buyable: msg.buyability?.isBuyable ?? msg.isBuyable ?? null,
    });
  }

  return { pickup, delivery };
}

export function availabilityKeys({ pickup, delivery }) {
  const keys = new Map();
  for (const p of pickup) if (p.available) keys.set(`pickup:${p.storeNumber}:${p.partNumber}`, p);
  for (const d of delivery) if (d.courierAvailable) keys.set(`courier:${d.partNumber}`, d);
  return keys;
}

function stripHtml(s) {
  return String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

const SKIP_DIMENSIONS = new Set(['dimensionSteporder']);

export function parseCatalog(html) {
  const data = productSelectionData(html);
  if (data?.mainDisplayValues) return parseMacCatalog(html, data);
  const products = uniqueParts((data?.products ?? []).filter((p) => p.partNumber));
  if (!products.length) return null;
  const values = data.displayValues ?? {};
  const images = data.imageDictionary ?? {};
  const keys = [...new Set([...(data.sections ?? []).map((s) => s.dimension ?? s.formFieldName), ...Object.keys(values)])].filter(
    (k) => /^dimension/.test(k ?? '') && !SKIP_DIMENSIONS.has(k) && values[k]?.variantOrder,
  );
  const dimensions = keys
    .map((key) => ({
      key,
      options: values[key].variantOrder
        .filter((v) => products.some((p) => p[key] === v))
        .map((v) => ({
          key: v,
          name: optionLabel(values[key][v]?.value ?? v),
          ...(key === 'dimensionColor' && { swatch: imgSrc(values[key][v]?.image) }),
        })),
    }))
    .filter((d) => d.options.length > 1);
  return {
    title: pageTitle(html),
    dimensions,
    models: products.map((p) => ({
      partNumber: p.partNumber,
      dims: Object.fromEntries(keys.map((k) => [k, p[k]])),
      image: firstSrc(images[p.imageKey]?.sources?.[0]?.srcSet),
      price: values.prices?.[p.fullPrice]?.amountBeforeTradeIn ?? pricePart(p.price),
    })),
    productImages: compareImages(html),
  };
}

// US iPhone pages repeat each part once per carrier (same part, same stock);
// keep one entry, preferring the unlocked one for its price.
function uniqueParts(products) {
  const byPart = new Map();
  for (const p of products) {
    const seen = byPart.get(p.partNumber);
    if (!seen || (seen.isCarrierDevice && !p.isCarrierDevice)) byPart.set(p.partNumber, p);
  }
  return [...byPart.values()];
}

// Mac pages list build-to-order configs too; only preconfigured ones have a
// part number, and those are the ones stores stock.
function parseMacCatalog(html, data) {
  const products = (data.products ?? []).filter((p) => p.btrOrFdPartNumber);
  if (!products.length) return null;
  const values = data.mainDisplayValues;
  const raw = [...new Set([...(data.mainSections ?? []).map((s) => s.formFieldName), ...Object.keys(values)])].filter(
    (k) => k && values[k]?.variantOrder,
  );
  const keyOf = (k) =>
    k.includes('dimension')
      ? k.slice(k.indexOf('dimension')).replace(/-(\w)/g, (_, c) => c.toUpperCase())
      : `dimension${k.split('-').slice(1).map((w) => w[0].toUpperCase() + w.slice(1)).join('')}`;
  const fallback = html.match(/property="og:image"\s+content="([^"]+)"/)?.[1].replace(/&amp;/g, '&') ?? null;
  const colors = values['chassis-dimensionColor'] ?? {};
  const colorImage = (v) => {
    const name = colors[v]?.image?.imageName?.replace(/_SW_COLOR$/, '');
    return name ? `https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/${name}?wid=904&hei=840&fmt=jpeg&qlt=90` : null;
  };
  const dimensions = raw
    .map((k) => ({
      key: keyOf(k),
      options: values[k].variantOrder
        .filter((v) => products.some((p) => p.dimensions?.[k] === v))
        .map((v) => ({
          key: v,
          name: optionLabel(values[k][v]?.header ?? coreLabel(values[k][v]?.dimensionComponents) ?? v),
          ...(keyOf(k) === 'dimensionColor' && { swatch: firstSrc(values[k][v]?.image?.sources?.[0]?.srcSet) }),
        })),
    }))
    .filter((d) => d.options.length > 1);
  return {
    title: pageTitle(html),
    dimensions,
    models: products.map((p) => ({
      partNumber: p.btrOrFdPartNumber,
      dims: Object.fromEntries(raw.map((k) => [keyOf(k), p.dimensions?.[k]])),
      image: colorImage(p.dimensions?.['chassis-dimensionColor']) ?? fallback,
      price: values.prices?.[p.priceKey]?.amount ?? null,
    })),
    productImages: {},
  };
}

function coreLabel(c) {
  return c?.cpuCoreCount && c?.gpuCoreCount ? `${c.cpuCoreCount}-core CPU, ${c.gpuCoreCount}-core GPU` : null;
}

function optionLabel(value) {
  return stripHtml(String(value).split(/<as-footnote|<div/)[0].replace(/&nbsp;|\u00a0/g, ' ').replace(/\u2011/g, '-'));
}

function pricePart(value) {
  return typeof value === 'string' && /^\d+_\d{2}$/.test(value) ? Number(value.replace('_', '.')) : null;
}

export function pageTitle(html) {
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1]?.replace(/&nbsp;|\u00a0/g, ' ');
  return title?.replace(/^(Buy|Shop)\s+/, '').replace(/\s+-\s+Apple.*$/, '').trim() || null;
}

export function productSelectionData(html) {
  const start = html.indexOf('productSelectionData:', html.indexOf('PRODUCT_SELECTION_BOOTSTRAP'));
  if (start < 0) return null;
  const open = html.indexOf('{', start);
  let depth = 0;
  let inString = false;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(open, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function compareImages(html) {
  const out = {};
  const re = /https:\/\/store\.storeimages\.cdn-apple\.com\/[^"\s\\]*?\/is\/iphone-compare-(iphone-[a-z0-9-]+?)-\d{6}\?wid=400&(?:amp;)?hei=512[^"\s\\]*/g;
  for (const m of html.matchAll(re)) out[`buy-iphone/${m[1]}`] ??= m[0].replace(/&amp;/g, '&');
  return out;
}

function imgSrc(html) {
  return html?.match(/src="([^"]+)"/)?.[1].replace(/&amp;/g, '&') ?? null;
}

function firstSrc(srcSet) {
  return srcSet?.split(',')[0].trim().split(/\s+/)[0] ?? null;
}
