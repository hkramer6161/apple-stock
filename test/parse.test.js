import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { availabilityKeys, parseCatalog, parseFulfillment, parseProducts, selectProducts, shortPickupQuote } from '../src/parse.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const catalog = [
  { partNumber: 'MK244VC/A', name: 'iPhone Duo 256GB Star White', price: 2999 },
  { partNumber: 'MK254VC/A', name: 'iPhone Duo 256GB Night Sky', price: 2999 },
  { partNumber: 'MK274VC/A', name: 'iPhone Duo 512GB Night Sky', price: 3299 },
];

test('parseProducts reads the metrics product list', () => {
  const html = `<script type=application/json id=metrics>${JSON.stringify({ data: { products: [{ sku: 'MK244', partNumber: 'MK244VC/A', price: { fullPrice: 2999 }, name: 'iPhone Duo 256GB Star White' }] } })}</script>`;
  assert.deepEqual(parseProducts(html), [{ partNumber: 'MK244VC/A', name: 'iPhone Duo 256GB Star White', price: 2999 }]);
  assert.deepEqual(parseProducts('<html></html>'), []);
  const many = { data: { products: ['iPhone Duo 1TB Star White', 'iPhone Duo 256GB Night Sky', 'iPhone Duo 2TB Night Sky', 'iPhone Duo 512GB Star White'].map((name, i) => ({ partNumber: `P${i}`, name })) } };
  assert.deepEqual(parseProducts(`<script type=application/json id=metrics>${JSON.stringify(many)}</script>`).map((p) => p.name.split(' ')[2]), ['256GB', '512GB', '1TB', '2TB']);
});

test('selectProducts matches all, part numbers and name words', () => {
  assert.equal(selectProducts(catalog, 'all').length, 3);
  assert.equal(selectProducts(catalog, '').length, 3);
  assert.deepEqual(selectProducts(catalog, 'mk244vc/a').map((p) => p.partNumber), ['MK244VC/A']);
  assert.deepEqual(selectProducts(catalog, 'night sky').map((p) => p.partNumber), ['MK254VC/A', 'MK274VC/A']);
  assert.deepEqual(selectProducts(catalog, '256GB Night Sky, 512GB').map((p) => p.partNumber), ['MK254VC/A', 'MK274VC/A']);
});

test('unavailable iPhone Duo response yields no availability', () => {
  const parsed = parseFulfillment(fixture('duo-unavailable.json'));
  assert.equal(parsed.pickup.length, 80);
  assert.equal(parsed.delivery.length, 8);
  assert.ok(parsed.pickup.every((p) => !p.available));
  assert.match(parsed.pickup[0].quote, /Check back for availability/);
  assert.ok(parsed.delivery.every((d) => !d.courierAvailable));
  assert.equal(parsed.delivery.find((d) => d.partNumber === 'MK294VC/A').shipText, 'Ships 22 Jan');
  assert.equal(availabilityKeys(parsed).size, 0);
});

test('in-stock pickup is detected per store and distance filter applies', () => {
  const parsed = parseFulfillment(fixture('iphone17-pickup-available.json'));
  const eaton = parsed.pickup.filter((p) => p.storeName === 'Eaton Centre');
  assert.ok(eaton.some((p) => p.available && p.quote === 'Available Today'));
  assert.ok(eaton.some((p) => !p.available && p.quote === 'Currently unavailable'));
  assert.ok(availabilityKeys(parsed).has('pickup:R121:MG6A4VC/A'));

  const near = parseFulfillment(fixture('iphone17-pickup-available.json'), { maxDistanceKm: 5 });
  assert.deepEqual([...new Set(near.pickup.map((p) => p.storeName))], ['Eaton Centre']);
});

test('2-hr courier availability is keyed per part', () => {
  const json = {
    body: {
      content: {
        pickupMessage: { stores: [] },
        deliveryMessage: {
          geoEnabled: false,
          'MK244VC/A': { regular: { idl: true, stickyMessageIDL: 'Get it in 2 hours', stickyMessageSTH: 'In stock' } },
          'MK254VC/A': { regular: { idl: false, stickyMessageIDL: 'Unavailable for 2-hr delivery' } },
        },
      },
    },
  };
  const keys = availabilityKeys(parseFulfillment(json));
  assert.deepEqual([...keys.keys()], ['courier:MK244VC/A']);
});

test('parseFulfillment rejects unexpected responses', () => {
  assert.throws(() => parseFulfillment({ head: {} }), /Unexpected/);
});

test('summarize reports nearest pickup store, courier and fallback text', async () => {
  const { summarize, buildMessage } = await import('../src/checker.js');
  const selected = [
    { partNumber: 'A', name: 'iPhone Duo 256GB Star White' },
    { partNumber: 'B', name: 'iPhone Duo 256GB Night Sky' },
  ];
  const results = {
    pickup: [
      { partNumber: 'A', storeName: 'Eaton Centre', distance: '1.23 km', available: true, quote: 'Available Today' },
      { partNumber: 'A', storeName: 'Yorkdale', distance: '10.62 km', available: true, quote: 'Available Today' },
      { partNumber: 'B', storeName: 'Eaton Centre', distance: '1.23 km', available: false, quote: 'Check back for availability on 10.24' },
    ],
    delivery: [
      { partNumber: 'A', courierAvailable: true, shipText: 'In stock' },
      { partNumber: 'B', courierAvailable: false, shipText: 'Ships 22 Jan' },
    ],
  };
  assert.deepEqual(summarize(selected, results).map((m) => [m.status, m.hit]), [
    ['Pickup Eaton Centre 1.23 km +1 · 2-hr courier', true],
    ['Pickup 10.24 · Ships 22 Jan', false],
  ]);
  const msg = buildMessage([{ ...results.pickup[0], storeNumber: 'R121' }], new Map([['A', selected[0].name]]), 'https://x');
  assert.equal(msg.subject, 'In stock: iPhone Duo 256GB Star White, pickup at Eaton Centre');
  const many = Array.from({ length: 40 }, (_, i) => ({ ...results.pickup[0], storeNumber: `R${i}` }));
  const long = buildMessage(many, new Map(), 'https://x');
  assert.equal(long.text.split('\n').length, 16);
  assert.match(long.text, /…and 25 more$/);
  assert.match(long.subject, /\(\+39 more\)$/);
});

test('shortPickupQuote compresses Apple pickup messages', () => {
  assert.equal(shortPickupQuote('Check back for availability on 10.24'), 'Pickup 10.24');
  assert.equal(shortPickupQuote('Currently unavailable'), 'No pickup');
  assert.equal(shortPickupQuote('Available Today'), 'Available Today');
  assert.equal(shortPickupQuote(undefined), '');
});

const page = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('parseCatalog reads colours, capacities, images and prices', async () => {
  const { filterVariants } = await import('../src/checker.js');
  const c = parseCatalog(page('duo-page.html'));
  const [colors, capacities] = c.dimensions;
  assert.equal(colors.key, 'dimensionColor');
  assert.deepEqual(colors.options.map((x) => [x.key, x.name]), [['starwhite', 'Star White'], ['nightsky', 'Night Sky']]);
  assert.match(colors.options[0].swatch, /^https:\/\/store\.storeimages\.cdn-apple\.com\/.*iphone-duo-finish-star-white.*&hei=/);
  assert.deepEqual(capacities.options.map((x) => x.name), ['256GB', '512GB', '1TB', '2TB']);
  assert.equal(c.models.length, 8);
  const m = c.models.find((x) => x.partNumber === 'MK244VC/A');
  assert.deepEqual([m.dims, m.price], [{ dimensionColor: 'starwhite', dimensionCapacity: '256gb' }, 2999]);
  assert.match(m.image, /iphone-duo-finish-select-star-white-202609\?wid=/);
  assert.match(c.productImages['buy-iphone/iphone-17'], /iphone-compare-iphone-17-\d{6}\?wid=400&hei=512/);
  assert.equal(parseCatalog('<html></html>'), null);
  const all = c.models.map((x) => ({ partNumber: x.partNumber }));
  assert.equal(filterVariants(all, c, {}).length, 8);
  const picked = filterVariants(all, c, { dimensionColor: ['nightsky'], dimensionCapacity: ['256gb', '1tb'] });
  assert.deepEqual(picked.map((x) => x.partNumber).sort(), ['MK254VC/A', 'MK294VC/A']);
});

test('parseCatalog handles iPad size, storage and connectivity options', async () => {
  const { filterVariants } = await import('../src/checker.js');
  const c = parseCatalog(page('ipad-air-page.html'));
  assert.equal(c.title, 'iPad Air');
  assert.deepEqual(c.dimensions.map((d) => d.key), ['dimensionScreensize', 'dimensionColor', 'dimensionCapacity', 'dimensionConnection']);
  assert.deepEqual(c.dimensions[3].options.map((o) => o.name), ['Wi-Fi', 'Wi-Fi + Cellular']);
  assert.deepEqual(c.dimensions[0].options.map((o) => o.name), ['11-inch model', '13-inch model']);
  assert.equal(c.models.length, 64);
  assert.ok(c.models.every((m) => m.price > 0 && m.image));
  const all = c.models.map((x) => ({ partNumber: x.partNumber }));
  assert.equal(filterVariants(all, c, { dimensionScreensize: ['13inch'], dimensionConnection: ['wifi'], dimensionCapacity: ['256gb'] }).length, 4);
});

test('AirPods pages without a metrics list still produce named models', async () => {
  const { modelsFromVariants } = await import('../src/checker.js');
  const html = page('airpods5-page.html');
  assert.deepEqual(parseProducts(html), []);
  const c = parseCatalog(html);
  assert.equal(c.title, 'AirPods 5');
  assert.deepEqual(c.dimensions.map((d) => d.key), ['dimensionCharging']);
  const models = modelsFromVariants(c);
  assert.equal(models.length, 2);
  assert.deepEqual(models.map((m) => [m.name, m.price]), [['AirPods 5', 179], ['AirPods 5 with Wireless Charging Case', 209]]);
});

test('Mac pages list only preconfigured in-store models', async () => {
  const { modelsFromVariants } = await import('../src/checker.js');
  const c = parseCatalog(page('macbook-pro-page.html'));
  assert.equal(c.title, 'MacBook Pro');
  assert.deepEqual(c.dimensions.map((d) => d.key), [
    'dimensionScreensize', 'dimensionColor', 'dimensionFinish', 'dimensionChip', 'dimensionChipCpuCoreCountGpuCoreCount',
  ]);
  assert.equal(c.models.length, 13);
  assert.ok(c.models.every((m) => /^[A-Z0-9]{5}LL\/A$/.test(m.partNumber)));
  const colors = c.dimensions.find((d) => d.key === 'dimensionColor').options;
  assert.deepEqual(colors.map((o) => o.name), ['Space Black', 'Silver']);
  assert.ok(colors.every((o) => o.swatch.startsWith('https://')));
  const m = c.models.find((x) => x.partNumber === 'MEQJ4LL/A');
  assert.equal(m.price, 3024);
  assert.match(m.image, /mbp14-spaceblack-cto-hero-202410\?wid=904/);
  const name = modelsFromVariants(c).find((x) => x.partNumber === 'MEQJ4LL/A').name;
  assert.equal(name, 'MacBook Pro 14-inch Space Black Nano-texture display M5 chip 10-core CPU, 10-core GPU');
});

test('product ids accept old iPhone slugs and reject unknown paths', async () => {
  const { normalizeProduct, productName } = await import('../src/apple.js');
  assert.equal(normalizeProduct('iphone-duo'), 'buy-iphone/iphone-duo');
  assert.equal(normalizeProduct('/buy-ipad/ipad-mini/'), 'buy-ipad/ipad-mini');
  assert.throws(() => normalizeProduct('buy-ipad/../../x'), /unsupported/);
  assert.equal(normalizeProduct('buy-mac/macbook-air'), 'buy-mac/macbook-air');
  assert.throws(() => normalizeProduct('buy-watch/apple-watch'), /unsupported/);
  assert.equal(productName('buy-ipad/ipad-mini'), 'iPad mini');
  assert.equal(productName('buy-airpods/airpods-max-2'), 'AirPods Max 2');
});

test('US stores report miles, which are filtered as km', () => {
  const store = (name, miles) => ({
    storeName: name, city: 'New York', storeNumber: name, storedistance: miles, storeDistanceWithUnit: `${miles} mi`,
    partsAvailability: { 'MG464LL/A': { partNumber: 'MG464LL/A', pickupDisplay: 'available', pickupSearchQuote: 'Available Tomorrow' } },
  });
  const data = { head: { status: '200' }, body: { content: { pickupMessage: { stores: [store('Near', 10), store('Far', 40)] }, deliveryMessage: {} } } };
  const { pickup } = parseFulfillment(data, { maxDistanceKm: 50 });
  assert.deepEqual(pickup.map((p) => [p.storeName, Math.round(p.distanceKm)]), [['Near', 16]]);
});

test('parseProducts keeps one entry per part when US pages repeat it per carrier', async () => {
  const product = (carrier) => ({ partNumber: 'MK1F4LL/A', name: 'iPhone Duo 256GB Night Sky', isCarrierDevice: carrier !== 'unlocked', carrierModel: carrier, price: { fullPrice: carrier === 'unlocked' ? 1099 : 1029 } });
  const metrics = { data: { products: ['ATT_IPHONEDUO', 'unlocked', 'VERIZON_IPHONEDUO'].map(product) } };
  const models = parseProducts(`<script type=application/json id=metrics>${JSON.stringify(metrics)}</script>`);
  assert.deepEqual(models, [{ partNumber: 'MK1F4LL/A', name: 'iPhone Duo 256GB Night Sky', price: 1099 }]);
});

test('parseCatalog keeps unlocked prices when US parts repeat by carrier', () => {
  const products = [
    { partNumber: 'MK1F4LL/A', isCarrierDevice: true, fullPrice: 'carrierA' },
    { partNumber: 'MK2F4LL/A', isCarrierDevice: false, fullPrice: 'unlockedB' },
    { partNumber: 'MK1F4LL/A', isCarrierDevice: false, fullPrice: 'unlockedA' },
    { partNumber: 'MK2F4LL/A', isCarrierDevice: true, fullPrice: 'carrierB' },
  ];
  const data = {
    products,
    displayValues: {
      prices: {
        carrierA: { amountBeforeTradeIn: 1029 },
        unlockedA: { amountBeforeTradeIn: 1099 },
        carrierB: { amountBeforeTradeIn: 1129 },
        unlockedB: { amountBeforeTradeIn: 1199 },
      },
    },
  };
  const parse = (orderedProducts) => parseCatalog(`PRODUCT_SELECTION_BOOTSTRAP:{productSelectionData:${JSON.stringify({ ...data, products: orderedProducts })}}`);

  for (const orderedProducts of [products, [...products].reverse()]) {
    const catalog = parse(orderedProducts);
    assert.deepEqual(
      catalog.models.map(({ partNumber, price }) => [partNumber, price]).sort(),
      [['MK1F4LL/A', 1099], ['MK2F4LL/A', 1199]],
    );
  }
});
