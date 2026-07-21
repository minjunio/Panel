const express = require('express');
const session = require('express-session');
const { ethers } = require('ethers');
const bip39 = require('bip39');
const ed25519 = require('ed25519-hd-key');
const { 
    Keypair, 
    Connection, 
    clusterApiUrl, 
    PublicKey, 
    SystemProgram, 
    Transaction, 
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL 
} = require('@solana/web3.js');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ================== SESSION ==================
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'vault-node-secure-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
        httpOnly: true,
        secure: false // set true behind HTTPS in production
    }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(sessionMiddleware);

// ================== PROVIDERS ==================
const ethProvider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
const solConnection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// ================== HELPERS ==================
function deriveWalletsFromMnemonic(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error('Invalid mnemonic phrase');
    }
    const ethWallet = ethers.Wallet.fromPhrase(mnemonic);
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const derivedSeed = ed25519.derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
    const solanaKeypair = Keypair.fromSeed(derivedSeed);
    
    return {
        mnemonic,
        ethAddress: ethWallet.address,
        ethPrivateKey: ethWallet.privateKey,
        solAddress: solanaKeypair.publicKey.toBase58(),
        solSecretKey: Buffer.from(solanaKeypair.secretKey).toString('hex')
    };
}

async function fetchLiveBalances(ethAddress, solAddress) {
    try {
        const ethBalanceWei = await ethProvider.getBalance(ethAddress);
        const ethBalance = parseFloat(ethers.formatEther(ethBalanceWei));
        
        const solPubKey = new PublicKey(solAddress);
        const solBalanceLamports = await solConnection.getBalance(solPubKey);
        const solBalance = solBalanceLamports / LAMPORTS_PER_SOL;
        
        const usd = (ethBalance * 3200) + (solBalance * 140);
        return { 
            eth: parseFloat(ethBalance.toFixed(6)), 
            sol: parseFloat(solBalance.toFixed(6)), 
            usd: parseFloat(usd.toFixed(2)) 
        };
    } catch (e) {
        console.error('Balance fetch error:', e.message);
        return { eth: 0, sol: 0, usd: 0 };
    }
}

async function sendTransaction(network, fromWallet, toAddress, amount) {
    if (network === 'ETH') {
        const wallet = new ethers.Wallet(fromWallet.ethPrivateKey, ethProvider);
        const tx = await wallet.sendTransaction({
            to: toAddress,
            value: ethers.parseEther(amount.toString())
        });
        await tx.wait(1);
        return { hash: tx.hash, network: 'ETH' };
    } else {
        const fromKeypair = Keypair.fromSecretKey(Buffer.from(fromWallet.solSecretKey, 'hex'));
        const lamports = Math.floor(parseFloat(amount) * LAMPORTS_PER_SOL);
        const transaction = new Transaction().add(SystemProgram.transfer({
            fromPubkey: fromKeypair.publicKey,
            toPubkey: new PublicKey(toAddress),
            lamports
        }));
        const signature = await sendAndConfirmTransaction(
            solConnection, 
            transaction, 
            [fromKeypair],
            { commitment: 'confirmed' }
        );
        return { hash: signature, network: 'SOL' };
    }
}

// ================== ROUTES ==================

// Landing
app.get('/', (req, res) => {
    if (req.session.wallet) {
        if (req.session.wallet.isAdmin) {
            return res.redirect('/admin/wallet');
        }
        return res.redirect('/wallet/portfolio');
    }
    res.render('index', { error: req.query.error || null });
});

// Generate new wallet
app.post('/generate', async (req, res) => {
    try {
        const mnemonic = bip39.generateMnemonic(128);
        const walletData = deriveWalletsFromMnemonic(mnemonic);
        walletData.balances = await fetchLiveBalances(walletData.ethAddress, walletData.solAddress);
        req.session.wallet = walletData;
        req.session.isAdmin = false;
        res.redirect('/wallet/portfolio');
    } catch (e) {
        res.render('index', { error: 'Failed to generate new wallet.' });
    }
});

// Import wallet
app.post('/import', async (req, res) => {
    try {
        const mnemonic = req.body.mnemonic.trim();
        const walletData = deriveWalletsFromMnemonic(mnemonic);
        walletData.balances = await fetchLiveBalances(walletData.ethAddress, walletData.solAddress);
        req.session.wallet = walletData;
        req.session.isAdmin = false;
        res.redirect('/wallet/portfolio');
    } catch (e) {
        res.render('index', { error: 'Invalid seed phrase. Please check and try again.' });
    }
});

// Admin Login
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'monterysasd') {
        req.session.isAdmin = true;
        req.session.wallet = { isAdmin: true, username: 'admin' };
        return res.redirect('/admin/wallet');
    }
    res.render('index', { error: 'Invalid admin credentials.' });
});

// User Wallet
app.get('/wallet/:tab', async (req, res) => {
    if (!req.session.wallet || req.session.wallet.isAdmin) {
        return res.redirect('/');
    }
    
    const activeTab = ['portfolio', 'send', 'receive'].includes(req.params.tab) ? req.params.tab : 'portfolio';
    
    if (activeTab === 'portfolio') {
        req.session.wallet.balances = await fetchLiveBalances(
            req.session.wallet.ethAddress, 
            req.session.wallet.solAddress
        );
    }
    
    res.render('wallet', { 
        wallet: req.session.wallet, 
        activeTab,
        success: req.query.success || null,
        error: req.query.error || null
    });
});

// Send (real on-chain)
app.post('/wallet/send', async (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    
    const { network, targetAddress, amount } = req.body;
    const userWallet = req.session.wallet;
    
    try {
        if (!targetAddress || !amount || parseFloat(amount) <= 0) {
            throw new Error('Invalid address or amount');
        }
        
        const result = await sendTransaction(network, userWallet, targetAddress, amount);
        
        res.redirect(`/wallet/send?success=${encodeURIComponent(
            `${network} sent successfully! TX: ${result.hash}`
        )}`);
    } catch (error) {
        res.redirect(`/wallet/send?error=${encodeURIComponent(error.message)}`);
    }
});

// Logout
app.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// ================== ADMIN ==================
app.get('/admin/wallet', (req, res) => {
    if (!req.session.isAdmin) {
        return res.redirect('/');
    }
    res.render('adminwallet', { 
        isAdmin: true,
        success: req.query.success || null,
        error: req.query.error || null
    });
});

app.post('/admin/send', async (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/');
    res.redirect('/admin/wallet?success=Admin send feature coming soon');
});

// ================== START ==================
app.listen(PORT, () => {
    console.log(`[VAULT NODE] Secure Wallet running on http://localhost:${PORT}`);
});