import { Actor } from 'apify';
import * as cheerio from 'cheerio';

await Actor.init();

const input = (await Actor.getInput()) || {};
const startUrls = Array.isArray(input.startUrls) && input.startUrls.length > 0
    ? input.startUrls
    : [{ url: 'https://apify.com' }];

const BOOKING_PLATFORMS = [
    { name: 'Calendly', re: /calendly\.com/i },
    { name: 'OpenTable', re: /opentable\.com/i },
    { name: 'Doctolib', re: /doctolib\./i },
    { name: 'Zocdoc', re: /zocdoc\.com/i },
    { name: 'Mindbody', re: /mindbodyonline\.com/i },
    { name: 'Vagaro', re: /vagaro\.com/i },
    { name: 'Fresha', re: /fresha\.com/i },
    { name: 'Square Appointments', re: /squareup\.com\/appointments|square\.site/i },
    { name: 'Toast', re: /toasttab\.com/i },
    { name: 'Acuity Scheduling', re: /acuityscheduling\.com/i }
];

for (const item of startUrls) {
    const rawUrl = typeof item === 'string' ? item : item?.url;
    if (!rawUrl) continue;
    const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;

    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36' }
        });
        const html = await res.text();
        const $ = cheerio.load(html);

        const entities = [];
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const parsed = JSON.parse($(el).html() || '{}');
                const nodes = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
                for (const n of nodes) {
                    if (n && n['@type']) entities.push(n);
                }
            } catch {}
        });

        const biz = entities.find((e) => /LocalBusiness|Organization|Restaurant|Store|MedicalBusiness|Dentist|Physician|Attorney|RealEstateAgent|Hotel|AutoRepair/i.test(String(e['@type']))) || entities[0] || {};
        const bookingPlatforms = BOOKING_PLATFORMS.filter((b) => b.re.test(html)).map((b) => b.name);
        const emails = Array.from(new Set(html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,10}/g) || []))
            .filter((e) => !/\.(png|jpg|svg|webp|css|js)$/i.test(e))
            .slice(0, 10);
        const phones = Array.from(new Set(html.match(/(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}/g) || [])).slice(0, 8);

        await Actor.pushData({
            url,
            businessName: biz.name || $('meta[property="og:site_name"]').attr('content') || $('title').first().text().trim(),
            schemaType: biz['@type'] || 'Organization',
            telephone: biz.telephone || phones[0] || null,
            emails,
            priceRange: biz.priceRange || null,
            address: biz.address || null,
            geoCoordinates: biz.geo ? { latitude: biz.geo.latitude, longitude: biz.geo.longitude } : null,
            openingHours: biz.openingHoursSpecification || biz.openingHours || null,
            aggregateRating: biz.aggregateRating || null,
            bookingPlatforms,
            hasOnlineBooking: bookingPlatforms.length > 0,
            sameAsSocials: biz.sameAs || [],
            scrapedAt: new Date().toISOString()
        });
    } catch (err) {
        await Actor.pushData({ url, error: err.message, scrapedAt: new Date().toISOString() });
    }
}

await Actor.exit();
