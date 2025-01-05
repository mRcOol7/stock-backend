// Load environment variables from .env file
try {
    require('dotenv').config();
} catch (error) {
    console.error('Error loading .env file:', error);
}

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// Create axios instance with default config
const axiosInstance = axios.create({
    timeout: 30000, // Increase timeout to 30 seconds
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
    },
    httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false,
        keepAlive: true,
        timeout: 30000
    })
});

// Cache configuration
const CACHE_DURATION = 5000; // 5 seconds cache
let dataCache = {
    nifty50: { data: null, timestamp: 0 },
    bankNifty: { data: null, timestamp: 0 },
    cookies: { value: null, timestamp: 0 }
};

// Configure CORS with environment variables
const allowedOrigins = [
    'http://localhost:3000',
    'https://stock-data-eight.vercel.app'
];

app.use(cors({
    origin: function (origin, callback) {
        // allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400 // CORS preflight cache for 24 hours
}));

// Headers management
let HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
};

// Cookie management with caching
const getCookies = async (retries = 3) => {
    const now = Date.now();
    const cookieExpiry = parseInt(process.env.COOKIE_EXPIRY) || 300000; // 5 minutes default

    if (dataCache.cookies?.value && (now - dataCache.cookies.timestamp) < cookieExpiry) {
        HEADERS.Cookie = dataCache.cookies.value;
        return true;
    }

    for (let i = 0; i < retries; i++) {
        try {
            console.log(`Fetching new cookies... Attempt ${i + 1}/${retries}`);
            
            // First get the main page
            const mainResponse = await axiosInstance.get('https://www.nseindia.com/', {
                maxRedirects: 5,
                validateStatus: function (status) {
                    return status >= 200 && status < 400; // Accept redirects
                }
            });

            // Small delay between requests
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Then get the cookie page
            const cookieResponse = await axiosInstance.get('https://www.nseindia.com/api/marketStatus', {
                headers: {
                    ...HEADERS,
                    'Referer': 'https://www.nseindia.com/'
                }
            });

            if (mainResponse.headers['set-cookie'] || cookieResponse.headers['set-cookie']) {
                const cookies = [
                    ...(mainResponse.headers['set-cookie'] || []),
                    ...(cookieResponse.headers['set-cookie'] || [])
                ].map(cookie => cookie.split(';')[0]).join('; ');

                HEADERS.Cookie = cookies;
                dataCache.cookies = { value: cookies, timestamp: now };
                console.log('New cookies fetched successfully');
                return true;
            }
        } catch (error) {
            console.error(`Cookie fetch attempt ${i + 1} failed:`, error.message);
            if (i === retries - 1) {
                console.error('All cookie fetch attempts failed');
                throw error;
            }
            // Exponential backoff
            await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, i), 10000)));
        }
    }
    return false;
};

// Optimized NSE request function
const makeNSERequest = async (url, cacheKey, maxRetries = 3) => {
    const now = Date.now();
    if (dataCache[cacheKey]?.data && (now - dataCache[cacheKey].timestamp) < CACHE_DURATION) {
        console.log(`Using cached data for ${cacheKey}`);
        return dataCache[cacheKey].data;
    }

    for (let i = 0; i < maxRetries; i++) {
        try {
            console.log(`Fetching data for ${cacheKey}, attempt ${i + 1}/${maxRetries}`);
            
            // Add referer header for API requests
            const response = await axiosInstance.get(url, {
                headers: {
                    ...HEADERS,
                    'Referer': 'https://www.nseindia.com/'
                }
            });

            if (response.data) {
                dataCache[cacheKey] = { data: response.data, timestamp: now };
                console.log(`Data fetched successfully for ${cacheKey}`);
                return response.data;
            }
        } catch (error) {
            console.error(`Request failed for ${cacheKey}, attempt ${i + 1}:`, error.message);
            if (i === maxRetries - 1) throw error;
            
            // Exponential backoff with max delay of 10 seconds
            const delay = Math.min(1000 * Math.pow(2, i), 10000);
            console.log(`Waiting ${delay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Try to refresh cookies before next attempt
            try {
                await getCookies();
            } catch (cookieError) {
                console.error('Failed to refresh cookies:', cookieError.message);
            }
        }
    }
    throw new Error(`Failed to fetch data for ${cacheKey} after ${maxRetries} retries`);
};

// Utility function to make NSE requests with retries
const makeNSERequestOld = async (url, maxRetries = 3) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axiosInstance.get(url, { headers: HEADERS });
            return response.data;
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            await getCookies();
        }
    }
};

// Process stock data
const processStockData = (data) => {
    if (!data || !data.data || !Array.isArray(data.data)) {
        return [];
    }

    return data.data.map(stock => ({
        symbol: stock.symbol || '',
        identifier: stock.identifier || '',
        lastPrice: stock.lastPrice || 0,
        change: stock.change || 0,
        pChange: stock.pChange || 0,
        open: stock.open || 0,
        dayHigh: stock.dayHigh || 0,
        dayLow: stock.dayLow || 0,
        previousClose: stock.previousClose || 0,
        totalTradedVolume: stock.totalTradedVolume || 0,
        totalTradedValue: stock.totalTradedValue || 0,
        yearHigh: stock.yearHigh || 0,
        yearLow: stock.yearLow || 0,
        perChange365d: stock.perChange365d || 0,
        perChange30d: stock.perChange30d || 0,
        lastUpdateTime: stock.lastUpdateTime || new Date().toLocaleString()
    }));
};

// Function to check market status
const getMarketStatus = () => {
    const now = new Date();
    const indiaTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = indiaTime.getDay();
    const hours = indiaTime.getHours();
    const minutes = indiaTime.getMinutes();
    const currentTime = hours * 100 + minutes;

    // Check if it's a weekday (Monday-Friday)
    if (day >= 1 && day <= 5) {
        // Pre-market: 9:00 AM - 9:15 AM
        if (currentTime >= 900 && currentTime < 915) {
            return { status: 'pre-market', message: 'Pre-market Session' };
        }
        // Regular market hours: 9:15 AM - 3:30 PM
        else if (currentTime >= 915 && currentTime < 1530) {
            return { status: 'open', message: 'Market Open' };
        }
        // Post-market: 3:30 PM - 4:00 PM
        else if (currentTime >= 1530 && currentTime < 1600) {
            return { status: 'post-market', message: 'Post-market Session' };
        }
    }
    
    // Market is closed
    if (day === 0 || day === 6) {
        return { status: 'closed', message: 'Weekend - Market Closed' };
    }
    return { status: 'closed', message: 'Market Closed' };
};

// Proxy endpoint for NIFTY 50 data
app.get('/api/nifty50', async (req, res) => {
    try {
        const data = await makeNSERequest('https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050', 'nifty50');
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch data from NSE' });
    }
});

// API endpoints
app.get('/api/nifty', async (req, res) => {
    try {
        const data = await makeNSERequest('https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20500', 'nifty');
        const processedData = data ? processStockData(data) : [];
        res.json(processedData);
    } catch (error) {
        res.json([]);
    }
});

app.get('/api/banknifty', async (req, res) => {
    try {
        // Get fresh cookies before fetching BANK NIFTY data
        await getCookies();
        
        const data = await makeNSERequest('https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20BANK', 'bankNifty');
        const processedData = data ? processStockData(data) : [];
        res.json(processedData);
    } catch (error) {
        res.json([]);
    }
});

// Proxy endpoint for Bank Nifty stocks
app.get('/api/banknifty-stocks', async (req, res) => {
    try {
        // Fetch Bank Nifty constituent stocks
        const bankNiftyResponse = await makeNSERequest('https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20BANK', 'bankNifty');
        
        const bankNiftyStocks = bankNiftyResponse.data.map(stock => ({
            symbol: stock.symbol,
            open: stock.open,
            high: stock.dayHigh,
            low: stock.dayLow,
            preClose: stock.previousClose,
            lastPrice: stock.lastPrice,
            change: stock.change,
            pChange: stock.pChange,
            volume: stock.totalTradedVolume,
            indices: ['NIFTY BANK']
        }));

        res.json(bankNiftyStocks);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch Bank Nifty stocks' });
    }
});

// Proxy endpoint for stock details
app.get('/api/stock/:symbol', async (req, res) => {
    try {
        // First get the quote data
        const quoteResponse = await makeNSERequestOld(`https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(req.params.symbol)}`);
        
        // Then get the trade info data which has more detailed volume information
        const tradeInfoResponse = await makeNSERequestOld(`https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(req.params.symbol)}&section=trade_info`);
        
        // Combine the data
        const combinedData = {
            ...quoteResponse,
            tradeInfo: tradeInfoResponse
        };

        res.json(combinedData);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stock details' });
    }
});

// Proxy endpoint for historical data
app.get('/api/historical/:symbol', async (req, res) => {
    try {
        const symbol = req.params.symbol;
        const response = await makeNSERequestOld(`https://www.nseindia.com/api/historical/cm/equity?symbol=${encodeURIComponent(symbol)}`);
        
        // Transform the data for candlestick chart
        const historicalData = response.data.map(item => ({
            date: item.CH_TIMESTAMP,
            open: parseFloat(item.CH_OPENING_PRICE),
            high: parseFloat(item.CH_TRADE_HIGH_PRICE),
            low: parseFloat(item.CH_TRADE_LOW_PRICE),
            close: parseFloat(item.CH_CLOSING_PRICE)
        }));
        
        res.json(historicalData);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch historical data from NSE' });
    }
});

// Get index data
app.get('/api/indices', async (req, res) => {
    const startTime = Date.now();
    try {
        console.log('Fetching indices data...');
        const marketStatus = getMarketStatus();
        await getCookies();
        
        const [nifty50Data, bankNiftyData] = await Promise.all([
            makeNSERequest(
                'https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050',
                'nifty50'
            ).catch(error => {
                console.error('NIFTY 50 fetch error:', error.message);
                return { data: [null] };
            }),
            makeNSERequest(
                'https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20BANK',
                'bankNifty'
            ).catch(error => {
                console.error('BANK NIFTY fetch error:', error.message);
                return { data: [null] };
            })
        ]);

        console.log('NIFTY API Response:', nifty50Data);
        console.log('BANKNIFTY API Response:', bankNiftyData);

        const indices = {
            marketStatus,
            nifty50: nifty50Data?.data?.[0] || {
                symbol: 'NIFTY 50',
                lastPrice: 0,
                change: 0,
                pChange: 0,
                open: 0,
                dayHigh: 0,
                dayLow: 0,
                previousClose: 0,
                yearHigh: 0,
                yearLow: 0,
                totalTradedVolume: 0,
                totalTradedValue: 0,
                lastUpdateTime: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
            },
            bankNifty: bankNiftyData?.data?.[0] || {
                symbol: 'NIFTY BANK',
                lastPrice: 0,
                change: 0,
                pChange: 0,
                open: 0,
                dayHigh: 0,
                dayLow: 0,
                previousClose: 0,
                yearHigh: 0,
                yearLow: 0,
                totalTradedVolume: 0,
                totalTradedValue: 0,
                lastUpdateTime: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
            }
        };

        console.log('API Performance:', {
            timestamp: new Date().toLocaleTimeString(),
            totalFetchTime: `${(Date.now() - startTime).toFixed(2)}ms`,
            totalStocksFetched: nifty50Data?.data?.length + bankNiftyData?.data?.length || 0,
            niftyStocks: nifty50Data?.data?.length || 0,
            bankNiftyStocks: bankNiftyData?.data?.length || 0
        });

        res.json(indices);
    } catch (error) {
        console.error('Error in /api/indices:', error.message, error.stack);
        res.status(500).json({
            error: 'Failed to fetch data from NSE',
            message: error.message,
            timestamp: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
        });
    }
});

// Test endpoint for Vercel deployment
app.get('/', (req, res) => {
    res.json({ message: 'Hello from Vercel Server!' });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log('Environment:', process.env.NODE_ENV);
    console.log('Allowed Origins:', allowedOrigins);
});