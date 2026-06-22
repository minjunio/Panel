const express = require('express');
const session = require('express-session');
const { ethers } = require('ethers');
const bip39 = require('bip39');
const ed25519 = require('ed25519-hd-key');
const { Keypair } = require('@solana/web3.js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET || 'tactical-override-key-999',
    resave: false,
    saveUninitialized: true
}));

// Helper function to derive both wallets from a single mnemonic
function deriveWalletsFromMnemonic(mnemonic) {
    // 1. Derive EVM Wallet (Ethereum, Polygon, Base)
    const ethWallet = ethers.Wallet.fromPhrase(mnemonic);

    // 2. Derive Solana Wallet using standard Phantom derivation path
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const solanaDerivationPath = "m/44'/501'/0'/0'";
    const derivedSeed = ed25519.derivePath(solanaDerivationPath, seed.toString('hex')).key;
    const solanaKeypair = Keypair.fromSeed(derivedSeed);

    return {
        mnemonic,
        ethAddress: ethWallet.address,
        solAddress: solanaKeypair.publicKey.toBase58()
    };
}

// --- Routes ---

app.get('/', (req, res) => {
    if (req.session.wallet) return res.redirect('/wallet');
    res.render('index', { error: null });
});

app.post('/generate', (req, res) => {
    try {
        const mnemonic = bip39.generateMnemonic();
        req.session.wallet = deriveWalletsFromMnemonic(mnemonic);
        res.redirect('/wallet');
    } catch (error) {
        console.error(error);
        res.render('index', { error: 'Failed to generate cryptographic seed.' });
    }
});

app.post('/import', (req, res) => {
    try {
        const mnemonic = req.body.mnemonic.trim();
        if (!bip39.validateMnemonic(mnemonic)) throw new Error("Invalid mnemonic phrase.");
        
        req.session.wallet = deriveWalletsFromMnemonic(mnemonic);
        res.redirect('/wallet');
    } catch (error) {
        res.render('index', { error: 'INVALID SEED PHRASE. VERIFY INTEGRITY AND RETRY.' });
    }
});

app.get('/wallet', (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    res.render('wallet', { wallet: req.session.wallet });
});

app.post('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));
