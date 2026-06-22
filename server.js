const express = require('express');
const session = require('express-session');
const { ethers } = require('ethers');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware Setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true })); // Parse form data
app.use(express.json());

// Session config (use a strong environment variable for secret in production)
app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-secret-key-123',
    resave: false,
    saveUninitialized: true
}));

// --- Routes ---

// 1. Home / Setup Page
app.get('/', (req, res) => {
    // If they already have a wallet in session, send them straight to the dashboard
    if (req.session.wallet) {
        return res.redirect('/wallet');
    }
    res.render('index', { error: null });
});

// 2. Generate New Wallet
app.post('/generate', (req, res) => {
    try {
        // Create a random wallet using ethers.js
        const wallet = ethers.Wallet.createRandom();
        
        // Store wallet data in the session
        req.session.wallet = {
            address: wallet.address,
            mnemonic: wallet.mnemonic.phrase,
            privateKey: wallet.privateKey
        };
        
        res.redirect('/wallet');
    } catch (error) {
        console.error(error);
        res.render('index', { error: 'An error occurred while generating the wallet.' });
    }
});

// 3. Import Existing Wallet
app.post('/import', (req, res) => {
    try {
        const mnemonic = req.body.mnemonic.trim();
        
        // Reconstruct the wallet from the seed phrase
        const wallet = ethers.Wallet.fromPhrase(mnemonic);
        
        req.session.wallet = {
            address: wallet.address,
            mnemonic: wallet.mnemonic.phrase,
            privateKey: wallet.privateKey
        };
        
        res.redirect('/wallet');
    } catch (error) {
        // If fromPhrase fails, the seed phrase is invalid
        res.render('index', { error: 'Invalid seed phrase. Please check your 12 or 24 words.' });
    }
});

// 4. Wallet Dashboard
app.get('/wallet', (req, res) => {
    // Protect route: Ensure wallet exists in session
    if (!req.session.wallet) {
        return res.redirect('/');
    }
    res.render('wallet', { wallet: req.session.wallet });
});

// 5. Logout / Clear Wallet
app.post('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
