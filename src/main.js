import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrls = [{ url: 'https://crawlee.dev' }],
    maxCrawlDepth = 1,
    maxPagesPerDomain = 4,
} = input;

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,15}\b/g;
const PHONE_REGEX = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;
const BOOKING_DOMAINS = [
    'calendly.com',
    'acuityscheduling.com',
    'mindbodyonline.com',
    'doctolib.',
    'zocdoc.com',
    'opentable.com',
    'resy.com',
    'ToastTab.com',
    'booksy.com',
    'fresha.com',
    'vagaro.com',
    'square.site',
    'squareup.com/appointments',
];

const SOCIAL_PATTERNS = {
    linkedin: /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9_-]+/i,
    facebook: /https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9._-]+/i,
    instagram: /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._-]+/i,
    youtube: /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:@|[A-Za-z0-9_-]+)|youtu\.be\/[A-Za-z0-9_-]+)/i,
    tiktok: /https?:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9._-]+/i,
};

const domainAggregates = new Map();
const domainPageCounts = new Map();

function getDomainKey(rawUrl) {
    try {
        return new URL(rawUrl).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
        return rawUrl;
    }
}

function initDomainRecord(domain, startUrl) {
    if (!domainAggregates.has(domain)) {
        domainAggregates.set(domain, {
            domain,
            startUrl,
            businessName: null,
            businessType: null,
            priceRange: null,
            AggregateRating: null,
            address: null,
            geo: null,
            openingHours: [],
            emails: new Set(),
            phones: new Set(),
            bookingLinks: new Set(),
            googleMapsLinks: new Set(),
            socialProfiles: {},
            crawledPages: [],
        });
    }
    return domainAggregates.get(domain);
}

function extractSchemaNodes($, record) {
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const raw = $(el).contents().text().trim();
            if (!raw) return;
            const parsed = JSON.parse(raw);
            const queue = Array.isArray(parsed) ? [...parsed] : [parsed];

            while (queue.length > 0) {
                const node = queue.shift();
                if (!node || typeof node !== 'object') continue;
                if (Array.isArray(node['@graph'])) {
                    queue.push(...node['@graph']);
                }
                const rawType = node['@type'];
                const types = Array.isArray(rawType) ? rawType : [rawType];
                const isBusinessOrOrg = types.some((t) =>
                    typeof t === 'string' &&
                    /LocalBusiness|Organization|Restaurant|MedicalBusiness|Dentist|Store|ProfessionalService|Hotel|AutoRepair|HealthAndBeautyBusiness|LegalService/i.test(t)
                );

                if (isBusinessOrOrg) {
                    if (!record.businessName && node.name) record.businessName = String(node.name).trim();
                    if (!record.businessType && rawType) record.businessType = Array.isArray(rawType) ? rawType.join(', ') : String(rawType);
                    if (!record.priceRange && node.priceRange) record.priceRange = String(node.priceRange);
                    if (node.email) record.emails.add(String(node.email).replace(/^mailto:/i, '').trim().toLowerCase());
                    if (node.telephone) record.phones.add(String(node.telephone).trim());
                    if (node.hasMap) record.googleMapsLinks.add(String(node.hasMap));

                    if (node.address && typeof node.address === 'object' && !record.address) {
                        const a = node.address;
                        record.address = {
                            streetAddress: a.streetAddress || null,
                            addressLocality: a.addressLocality || null,
                            addressRegion: a.addressRegion || null,
                            postalCode: a.postalCode || null,
                            addressCountry: a.addressCountry || null,
                        };
                    }

                    if (node.geo && typeof node.geo === 'object' && !record.geo) {
                        record.geo = {
                            latitude: node.geo.latitude ?? null,
                            longitude: node.geo.longitude ?? null,
                        };
                    }

                    if (node.aggregateRating && typeof node.aggregateRating === 'object' && !record.AggregateRating) {
                        record.AggregateRating = {
                            ratingValue: node.aggregateRating.ratingValue ?? null,
                            reviewCount: node.aggregateRating.reviewCount ?? node.aggregateRating.ratingCount ?? null,
                        };
                    }

                    if (node.openingHoursSpecification) {
                        const specs = Array.isArray(node.openingHoursSpecification)
                            ? node.openingHoursSpecification
                            : [node.openingHoursSpecification];
                        for (const s of specs) {
                            if (s && (s.dayOfWeek || s.opens)) {
                                record.openingHours.push({
                                    dayOfWeek: s.dayOfWeek || null,
                                    opens: s.opens || null,
                                    closes: s.closes || null,
                                });
                            }
                        }
                    } else if (node.openingHours) {
                        const hrs = Array.isArray(node.openingHours) ? node.openingHours : [node.openingHours];
                        for (const h of hrs) {
                            record.openingHours.push(String(h));
                        }
                    }
                }
            }
        } catch {
            // Ignore malformed JSON-LD blocks
        }
    });
}

const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: startUrls.length * maxPagesPerDomain,
    async requestHandler({ request, $, enqueueLinks }) {
        const domain = getDomainKey(request.loadedUrl || request.url);
        const record = initDomainRecord(domain, request.url);
        record.crawledPages.push(request.loadedUrl || request.url);

        if (!record.businessName) {
            const ogSite = $('meta[property="og:site_name"]').attr('content');
            const title = $('title').first().text().trim();
            record.businessName = (ogSite || title || domain).split('|')[0].split('-')[0].trim();
        }

        extractSchemaNodes($, record);

        const bodyText = $.text();
        const foundEmails = bodyText.match(EMAIL_REGEX) || [];
        for (const email of foundEmails) {
            const clean = email.toLowerCase();
            if (!/\.(png|jpg|jpeg|gif|svg|webp|woff|css|js)$/i.test(clean) && !clean.includes('example.com') && !clean.includes('sentry.io')) {
                record.emails.add(clean);
            }
        }

        const foundPhones = bodyText.match(PHONE_REGEX) || [];
        for (const p of foundPhones) {
            const digits = p.replace(/\D/g, '');
            if (digits.length >= 10 && digits.length <= 15) {
                record.phones.add(p.trim());
            }
        }

        $('a[href]').each((_, el) => {
            const href = ($(el).attr('href') || '').trim();
            if (!href) return;
            if (href.startsWith('mailto:')) {
                const email = href.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
                if (email.includes('@')) record.emails.add(email);
            } else if (href.startsWith('tel:')) {
                const phone = href.replace(/^tel:/i, '').trim();
                if (phone.length >= 7) record.phones.add(phone);
            } else {
                const lower = href.toLowerCase();
                if (BOOKING_DOMAINS.some((b) => lower.includes(b))) {
                    record.bookingLinks.add(href);
                }
                if (lower.includes('google.com/maps') || lower.includes('maps.app.goo.gl') || lower.includes('goo.gl/maps')) {
                    record.googleMapsLinks.add(href);
                }
                for (const [platform, regex] of Object.entries(SOCIAL_PATTERNS)) {
                    if (!record.socialProfiles[platform]) {
                        const match = href.match(regex);
                        if (match) record.socialProfiles[platform] = match[0];
                    }
                }
            }
        });

        const currentDepth = request.userData?.depth ?? 0;
        const count = (domainPageCounts.get(domain) ?? 1);
        if (currentDepth < maxCrawlDepth && count < maxPagesPerDomain) {
            await enqueueLinks({
                strategy: 'same-domain',
                globs: [
                    '**/contact*',
                    '**/about*',
                    '**/location*',
                    '**/book*',
                    '**/appointment*',
                    '**/hours*',
                ],
                userData: { depth: currentDepth + 1 },
                transformRequestFunction: (req) => {
                    const current = domainPageCounts.get(domain) ?? 1;
                    if (current >= maxPagesPerDomain) return false;
                    domainPageCounts.set(domain, current + 1);
                    return req;
                },
            });
        }
    },
});

await crawler.run(startUrls);

for (const [, record] of domainAggregates.entries()) {
    const outputItem = {
        domain: record.domain,
        startUrl: record.startUrl,
        businessName: record.businessName,
        businessType: record.businessType || 'LocalBusiness',
        priceRange: record.priceRange,
        aggregateRating: record.AggregateRating,
        address: record.address,
        geo: record.geo,
        openingHours: record.openingHours.slice(0, 14),
        emails: [...record.emails],
        phones: [...record.phones].slice(0, 10),
        bookingLinks: [...record.bookingLinks],
        googleMapsLinks: [...record.googleMapsLinks],
        socialProfiles: record.socialProfiles,
        crawledPagesCount: record.crawledPages.length,
        crawledPages: record.crawledPages,
        enrichedAt: new Date().toISOString(),
    };

    await Actor.pushData(outputItem);

    try {
        if (typeof Actor.charge === 'function') {
            await Actor.charge({ eventName: 'business-enriched', count: 1 });
        }
    } catch (err) {
        log.debug(`PPE charge skipped in local environment: ${err.message}`);
    }
}

await Actor.exit();
