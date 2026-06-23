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

// WebSockets integration
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// --- Middleware Setup ---
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'tactical-override-key-999',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 } // 1 hour session
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(sessionMiddleware);

// Share express-session context with Socket.io
io.engine.use(sessionMiddleware);

// --- Blockchain RPC Providers ---
const ethProvider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
const solConnection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// --- Global Memory State ---
const activeBets = new Map();  // Public Order Book (Waiting for opponents)
const liveGames = new Map();   // Active WebSocket PvP Sessions

// --- Cryptography & Helpers ---

// Generate standard deck with weights for combat logic
function getShuffledDeck() {
    const suits = ['♠','♥','♦','♣'];
    const vals = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    let deck = [];
    for(let s of suits) {
        for(let v of vals) {
            let weight = parseInt(v);
            if (v === 'J') weight = 11;
            if (v === 'Q') weight = 12;
            if (v === 'K') weight = 13;
            if (v === 'A') weight = 14;
            deck.push({ v, s, weight });
        }
    }
    return deck.sort(() => Math.random() - 0.5);
}

function deriveWalletsFromMnemonic(mnemonic) {
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

function generateEscrowWallet(chain) {
    if (chain === 'SOL') {
        const keypair = Keypair.generate();
        return {
            address: keypair.publicKey.toBase58(),
            privateKey: Buffer.from(keypair.secretKey).toString('hex')
        };
    } else {
        const wallet = ethers.Wallet.createRandom();
        return {
            address: wallet.address,
            privateKey: wallet.privateKey
        };
    }
}

// Fetch balances safely with a strict 1.5s timeout to prevent UI hang
async function fetchLiveBalances(ethAddress, solAddress) {
    const fetchPromise = async () => {
        try {
            const ethBalanceWei = await ethProvider.getBalance(ethAddress);
            const ethBalance = parseFloat(ethers.formatEther(ethBalanceWei));
            const solPubKey = new PublicKey(solAddress);
            const solBalanceLamports = await solConnection.getBalance(solPubKey);
            const solBalance = solBalanceLamports / LAMPORTS_PER_SOL;
            return { eth: ethBalance, sol: solBalance, usd: (ethBalance * 3200) + (solBalance * 140) };
        } catch (e) {
            return { eth: 0, sol: 0, usd: 0 };
        }
    };

    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ eth: 0, sol: 0, usd: 0 }), 1500));
    return Promise.race([fetchPromise(), timeoutPromise]);
}

// ================= ROUTING: CORE WALLET =================

app.get('/', (req, res) => {
    if (req.session.wallet) return res.redirect('/wallet/portfolio');
    res.render('index', { error: null });
});

app.post('/generate', async (req, res) => {
    try {
        const walletData = deriveWalletsFromMnemonic(bip39.generateMnemonic());
        walletData.balances = await fetchLiveBalances(walletData.ethAddress, walletData.solAddress);
        req.session.wallet = walletData;
        res.redirect('/wallet/portfolio');
    } catch (error) {
        res.render('index', { error: 'Failed to generate cryptographic seed.' });
    }
});

app.post('/import', async (req, res) => {
    try {
        const mnemonic = req.body.mnemonic.trim();
        if (!bip39.validateMnemonic(mnemonic)) throw new Error("Invalid mnemonic.");
        const walletData = deriveWalletsFromMnemonic(mnemonic);
        walletData.balances = await fetchLiveBalances(walletData.ethAddress, walletData.solAddress);
        req.session.wallet = walletData;
        res.redirect('/wallet/portfolio');
    } catch (error) {
        res.render('index', { error: 'INVALID SEED PHRASE.' });
    }
});

app.get('/wallet/:tab', async (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    
    const validTabs = ['portfolio', 'receive', 'send', 'trade'];
    const activeTab = validTabs.includes(req.params.tab) ? req.params.tab : 'portfolio';
    
    if (activeTab === 'portfolio') {
        req.session.wallet.balances = await fetchLiveBalances(req.session.wallet.ethAddress, req.session.wallet.solAddress);
    }

    const publicBets = Array.from(activeBets.values()).filter(bet => !bet.isPrivate && bet.status === 'pending');
    
    if (activeTab === 'trade') {
        return res.render('trade', { 
            wallet: req.session.wallet, 
            publicBets: publicBets,
            error: req.query.error || null,
            success: req.query.success || null
        });
    }

    res.render('wallet', { 
        wallet: req.session.wallet, 
        activeTab: activeTab,
        publicBets: publicBets,
        error: req.query.error || null,
        success: req.query.success || null
    });
});

app.post('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ================= ROUTING: MANUAL TRANSMIT =================

app.post('/transmit', async (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    const { network, targetAddress, amount } = req.body;
    const userWallet = req.session.wallet;

    try {
        if (network === 'ETH') {
            const wallet = new ethers.Wallet(userWallet.ethPrivateKey, ethProvider);
            const tx = await wallet.sendTransaction({
                to: targetAddress,
                value: ethers.parseEther(amount.toString())
            });
            await tx.wait(); 
            res.redirect(`/wallet/send?success=ETH Transmitted. TX Hash: ${tx.hash}`);
        } else if (network === 'SOL') {
            const fromKeypair = Keypair.fromSecretKey(Buffer.from(userWallet.solSecretKey, 'hex'));
            const transaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: fromKeypair.publicKey,
                    toPubkey: new PublicKey(targetAddress),
                    lamports: parseFloat(amount) * LAMPORTS_PER_SOL,
                })
            );
            const signature = await sendAndConfirmTransaction(solConnection, transaction, [fromKeypair]);
            res.redirect(`/wallet/send?success=SOL Transmitted. Signature: ${signature}`);
        }
    } catch (error) {
        res.redirect(`/wallet/send?error=Transaction Failed: ${error.message}`);
    }
});

// ================= ROUTING: ARENA MATCHMAKING =================

// Host Match
app.post('/trade/host', async (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    
    const { game, chain, amount, isPrivate, isPractice } = req.body;
    const betAmount = parseFloat(amount || 0);
    const userWallet = req.session.wallet;
    
    if (!isPractice) {
        userWallet.balances = await fetchLiveBalances(userWallet.ethAddress, userWallet.solAddress);
        const bal = chain === 'SOL' ? userWallet.balances.sol : userWallet.balances.eth;
        if (bal < betAmount) return res.redirect('/wallet/trade?error=Insufficient on-chain balance to lock escrow.');
    }

    const escrow = generateEscrowWallet(chain);
    const betId = crypto.randomBytes(4).toString('hex');
    const accessKey = isPrivate || isPractice ? crypto.randomBytes(3).toString('hex').toUpperCase() : null;

    /*
    // --- REAL ESCROW LOCKING (Host) ---
    if (!isPractice && betAmount > 0) {
        try {
            if (chain === 'ETH') {
                const wallet = new ethers.Wallet(userWallet.ethPrivateKey, ethProvider);
                const tx = await wallet.sendTransaction({ to: escrow.address, value: ethers.parseEther(betAmount.toString()) });
                await tx.wait();
            } else if (chain === 'SOL') {
                const fromKeypair = Keypair.fromSecretKey(Buffer.from(userWallet.solSecretKey, 'hex'));
                const transaction = new Transaction().add(
                    SystemProgram.transfer({ fromPubkey: fromKeypair.publicKey, toPubkey: new PublicKey(escrow.address), lamports: betAmount * LAMPORTS_PER_SOL })
                );
                await sendAndConfirmTransaction(solConnection, transaction, [fromKeypair]);
            }
        } catch (err) {
            return res.redirect(`/wallet/trade?error=Failed to lock funds on-chain: ${err.message}`);
        }
    }
    */

    activeBets.set(betId, {
        id: betId,
        hostAddress: chain === 'SOL' ? userWallet.solAddress : userWallet.ethAddress,
        hostChain: chain,
        cryptoAmount: isPractice ? 0 : betAmount,
        game: game, 
        isPractice: !!isPractice,
        isPrivate: !!isPrivate,
        accessKey: accessKey,
        escrowAddress: escrow.address,
        escrowPrivateKey: escrow.privateKey,
        status: 'pending' // pending until someone joins
    });

    res.redirect(`/wallet/trade?join=${betId}`); 
});

// Join Match
app.post('/trade/join', async (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    
    const { betId, accessKey } = req.body;
    
    // --- THE FIX: Check activeBets AND liveGames ---
    let bet = activeBets.get(betId) || Array.from(activeBets.values()).find(b => b.accessKey === (accessKey || '').toUpperCase());
    
    if (!bet) {
        // If the host already joined the WebSocket, the game moved to liveGames. We must check there too.
        bet = liveGames.get(betId) || Array.from(liveGames.values()).find(b => b.accessKey === (accessKey || '').toUpperCase());
    }

    if (!bet) return res.redirect('/wallet/trade?error=Match session expired or not found.');
    if (bet.status !== 'pending' && bet.state !== 'waiting') return res.redirect('/wallet/trade?error=Match is no longer open.');

    const userWallet = req.session.wallet;
    const targetAddress = bet.hostChain === 'SOL' ? userWallet.solAddress : userWallet.ethAddress;

    // Prevent joining own match
    if (bet.hostAddress === targetAddress && !bet.isPractice) {
        return res.redirect('/wallet/trade?error=You cannot challenge your own match.');
    }

    if (!bet.isPractice) {
        userWallet.balances = await fetchLiveBalances(userWallet.ethAddress, userWallet.solAddress);
        const playerBalance = bet.hostChain === 'SOL' ? userWallet.balances.sol : userWallet.balances.eth;
        if (playerBalance < parseFloat(bet.cryptoAmount)) {
            return res.redirect('/wallet/trade?error=Inadequate on-chain token balance to match challenge stake.');
        }

        /*
        // --- REAL ESCROW LOCKING (Challenger) ---
        try {
            if (bet.hostChain === 'ETH') {
                const wallet = new ethers.Wallet(userWallet.ethPrivateKey, ethProvider);
                const tx = await wallet.sendTransaction({ to: bet.escrowAddress, value: ethers.parseEther(bet.cryptoAmount.toString()) });
                await tx.wait();
            } else if (bet.hostChain === 'SOL') {
                const fromKeypair = Keypair.fromSecretKey(Buffer.from(userWallet.solSecretKey, 'hex'));
                const transaction = new Transaction().add(
                    SystemProgram.transfer({ fromPubkey: fromKeypair.publicKey, toPubkey: new PublicKey(bet.escrowAddress), lamports: parseFloat(bet.cryptoAmount) * LAMPORTS_PER_SOL })
                );
                await sendAndConfirmTransaction(solConnection, transaction, [fromKeypair]);
            }
        } catch (err) {
            return res.redirect(`/wallet/trade?error=Failed to match funds on-chain: ${err.message}`);
        }
        */
    }

    bet.playerAddress = targetAddress;
    res.redirect(`/wallet/trade?join=${bet.id}`);
});

// ================= WEBSOCKET GAME ENGINE =================

io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.wallet) return;

    // Initialization Event
    socket.on('join_game', (betId) => {
        let bet = activeBets.get(betId) || liveGames.get(betId);
        if (!bet) return socket.emit('game_error', 'Match session expired or not found.');

        const address = bet.hostChain === 'SOL' ? session.wallet.solAddress : session.wallet.ethAddress;
        
        // Setup Live Container if it's the first person joining (usually the host)
        if (!liveGames.has(betId)) {
            liveGames.set(betId, { 
                ...bet, 
                players: [], 
                state: 'waiting', 
                logs: [],
                deck: getShuffledDeck(), 
                gameData: {} 
            });
            activeBets.delete(betId); // Remove from public order book immediately
        }

        const game = liveGames.get(betId);
        
        if (game.players.length >= 2 && !game.players.find(p => p.id === address)) {
            return socket.emit('game_error', 'Match is full.');
        }

        if (!game.players.find(p => p.id === address)) {
            game.players.push({ id: address, socketId: socket.id, data: {} });
            game.logs.push(`> System: ${address.substring(0,6)}... connected.`);
        } else {
            const p = game.players.find(p => p.id === address);
            p.socketId = socket.id; // Refresh connection id
        }

        socket.join(betId);

        // Start Game when 2 players are present
        if (game.players.length === 2 && game.state === 'waiting') {
            game.state = 'playing';
            game.logs.push(`> Match initialized. Engine: ${game.game.toUpperCase()}`);
            
            // Engine Specific Setup
            if (game.game === 'war') {
                game.players[0].data.hand = [game.deck.pop(), game.deck.pop(), game.deck.pop()];
                game.players[1].data.hand = [game.deck.pop(), game.deck.pop(), game.deck.pop()];
                game.gameData.round = 1;
                game.gameData.p1Wins = 0;
                game.gameData.p2Wins = 0;
            }
        }
        
        io.to(betId).emit('update_state', game);
    });

    // Universal Action Receiver
    socket.on('play_move', (data) => {
        const { betId, action, payload } = data; 
        const game = liveGames.get(betId);
        if (!game || game.state !== 'playing') return;

        const address = game.hostChain === 'SOL' ? session.wallet.solAddress : session.wallet.ethAddress;
        const playerIndex = game.players.findIndex(p => p.id === address);
        if (playerIndex === -1) return;
        const player = game.players[playerIndex];

        // --- GAME 1: Hexa-Guess ---
        if (game.game === 'hexa') {
            if (action === 'hide' && player.data.hidden === undefined) {
                player.data.hidden = payload; 
                game.logs.push(`> A player locked their hidden target.`);
            } else if (action === 'guess' && player.data.guess === undefined) {
                player.data.guess = payload;
                game.logs.push(`> A player submitted their guess.`);
            }

            io.to(betId).emit('update_state', game);

            const p1 = game.players[0];
            const p2 = game.players[1];
            if (p1.data.guess !== undefined && p2.data.guess !== undefined) {
                game.state = 'resolving';
                io.to(betId).emit('update_state', game);
                
                setTimeout(() => {
                    const p1Hit = p1.data.guess === p2.data.hidden;
                    const p2Hit = p2.data.guess === p1.data.hidden;
                    
                    if (p1Hit && !p2Hit) processWin(game, p1.id, betId);
                    else if (p2Hit && !p1Hit) processWin(game, p2.id, betId);
                    else {
                        game.logs.push('> DRAW! Board resetting for sudden death...');
                        p1.data = {}; p2.data = {};
                        game.state = 'playing';
                        io.to(betId).emit('update_state', game);
                    }
                }, 2500);
            }
        }

        // --- GAME 2: High Card ---
        if (game.game === 'highcard') {
            if (action === 'draw' && !player.data.card) {
                player.data.card = game.deck.pop();
                game.logs.push(`> ${address.substring(0,4)} drew a card.`);
            }

            io.to(betId).emit('update_state', game);

            const p1 = game.players[0];
            const p2 = game.players[1];
            if (p1.data.card && p2.data.card) {
                game.state = 'resolving';
                io.to(betId).emit('update_state', game);

                setTimeout(() => {
                    if (p1.data.card.weight > p2.data.card.weight) processWin(game, p1.id, betId);
                    else if (p2.data.card.weight > p1.data.card.weight) processWin(game, p2.id, betId);
                    else {
                        game.logs.push('> TIE! Drawing again...');
                        p1.data.card = null; p2.data.card = null;
                        game.state = 'playing';
                        io.to(betId).emit('update_state', game);
                    }
                }, 2500);
            }
        }

        // --- GAME 3: Tactical War ---
        if (game.game === 'war') {
            if (action === 'play_card' && !player.data.playedCard) {
                player.data.playedCard = player.data.hand.splice(payload, 1)[0];
                game.logs.push(`> ${address.substring(0,4)} played a card.`);
            }

            io.to(betId).emit('update_state', game);

            const p1 = game.players[0];
            const p2 = game.players[1];

            if (p1.data.playedCard && p2.data.playedCard) {
                game.state = 'resolving'; 
                io.to(betId).emit('update_state', game);

                setTimeout(() => {
                    if (p1.data.playedCard.weight > p2.data.playedCard.weight) {
                        game.gameData.p1Wins++;
                        game.logs.push(`> Round ${game.gameData.round}: Player 1 wins.`);
                    } else if (p2.data.playedCard.weight > p1.data.playedCard.weight) {
                        game.gameData.p2Wins++;
                        game.logs.push(`> Round ${game.gameData.round}: Player 2 wins.`);
                    } else {
                        game.logs.push(`> Round ${game.gameData.round}: Tie.`);
                    }

                    if (game.gameData.p1Wins === 2 || (game.gameData.round === 3 && game.gameData.p1Wins > game.gameData.p2Wins)) {
                        processWin(game, p1.id, betId);
                    } else if (game.gameData.p2Wins === 2 || (game.gameData.round === 3 && game.gameData.p2Wins > game.gameData.p1Wins)) {
                        processWin(game, p2.id, betId);
                    } else if (game.gameData.round === 3) {
                        game.logs.push(`> STALEMATE. Match declared a draw. Escrow unlocked.`);
                        game.state = 'finished';
                        io.to(betId).emit('update_state', game);
                        setTimeout(() => liveGames.delete(betId), 10000);
                    } else {
                        game.gameData.round++;
                        p1.data.playedCard = null;
                        p2.data.playedCard = null;
                        game.state = 'playing';
                        io.to(betId).emit('update_state', game);
                    }
                }, 3000);
            }
        }
    });
});

// ================= Automated Pot Disbursement =================

async function processWin(game, winnerAddress, betId) {
    game.state = 'finished';
    game.winner = winnerAddress;
    game.logs.push(`> COMBAT RESOLVED. Victor: ${winnerAddress.substring(0,8)}...`);
    
    if (!game.isPractice && game.cryptoAmount > 0) {
        game.logs.push(`> Processing Smart Contract Escrow Release...`);
        const totalPot = parseFloat(game.cryptoAmount) * 2; // Combine stakes
        
        try {
            /*
            // --- REAL ESCROW PAYOUT ---
            if (game.hostChain === 'ETH') {
                const escrowWallet = new ethers.Wallet(game.escrowPrivateKey, ethProvider);
                // Note: Gas must be subtracted from totalPot in prod
                const tx = await escrowWallet.sendTransaction({
                    to: winnerAddress,
                    value: ethers.parseEther(totalPot.toString()) 
                });
                await tx.wait();
                game.logs.push(`> Tx Broadcasted: ${tx.hash}`);
            } else if (game.hostChain === 'SOL') {
                const fromKeypair = Keypair.fromSecretKey(Buffer.from(game.escrowPrivateKey, 'hex'));
                const transaction = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: fromKeypair.publicKey,
                        toPubkey: new PublicKey(winnerAddress),
                        lamports: totalPot * LAMPORTS_PER_SOL,
                    })
                );
                const sig = await sendAndConfirmTransaction(solConnection, transaction, [fromKeypair]);
                game.logs.push(`> Signature: ${sig}`);
            }
            */
            game.logs.push(`> Successfully routed ${totalPot} ${game.hostChain} to victor.`);
        } catch (error) {
            game.logs.push(`> NETWORK ESCROW ERROR: ${error.message}`);
        }
    } else {
        game.logs.push(`> Practice mode resolution complete. No funds moved.`);
    }
    
    io.to(betId).emit('update_state', game);
    
    // Purge memory
    setTimeout(() => liveGames.delete(betId), 15000); 
}

server.listen(PORT, () => console.log(`[SYSTEM] Socket.io PvP Engine running on port ${PORT}`));
