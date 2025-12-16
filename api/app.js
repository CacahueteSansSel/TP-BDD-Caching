const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');
const app = express();
const port = 3000;

app.use(express.json());

// Config DB
const primaryConfig = {
    user: process.env.POSTGRESQL_USERNAME || 'app', // sors la config de variable d'environnement ou fallback par défaut si nécessaire
    host: 'haproxy',
    database: process.env.POSTGRESQL_DATABASE || 'appdb',
    password: process.env.POSTGRESQL_PASSWORD || 'app_pwd',
    port: 5432,
};

const replicaConfig = {
    user: process.env.POSTGRESQL_USERNAME || 'app', // idem
    host: 'localhost',
    database: process.env.POSTGRESQL_DATABASE || 'appdb',
    password: process.env.POSTGRESQL_PASSWORD || 'app_pwd',
    port: 5433,
};

// Vérif si on tourne sur docker
if (process.env.DOCKER_ENV) {
    primaryConfig.host = 'haproxy';
    primaryConfig.port = 5432;
    replicaConfig.host = 'db-replica';
    replicaConfig.port = 5432;
} else {
    primaryConfig.host = 'localhost';
    primaryConfig.port = 5439;
    replicaConfig.host = 'localhost';
    replicaConfig.port = 5433;
}

const poolPrimary = new Pool(primaryConfig);
const poolReplica = new Pool(replicaConfig);

// Client redis
const redisClient = redis.createClient({
    socket: {
        host: process.env.DOCKER_ENV ? 'redis' : 'localhost',
        port: 6379
    }
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

// Connexion du client redis en asynchrone (parralèle)
(async () => {
    await redisClient.connect();
})();

// POST /products - Création d'un produit
app.post('/products', async (req, res) => {
    const { name, price_cents } = req.body;

    try {
        const result = await poolPrimary.query(
            'INSERT INTO products (name, price_cents) VALUES ($1, $2) RETURNING *',
            [name, price_cents]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// GET /products/:id - Lecture d'un produit
app.get('/products/:id', async (req, res) => {
    const { id } = req.params;
    const cacheKey = `product:${id}`;

    try {
        // 1. Lecture depuis le cache
        let cachedData = null;
        if (redisClient.isReady) {
            try {
                cachedData = await redisClient.get(cacheKey);

                if (cachedData) {
                    console.log(`got cached data at ${cacheKey}`);

                    return res.json(JSON.parse(cachedData));
                }
            } catch (redisErr) {
                console.error('Redis GET error:', redisErr);
            }
        }

        console.log(`no cached data at ${cacheKey}`);

        // 2. Lecture sur le replica
        const result = await poolReplica.query('SELECT * FROM products WHERE id = $1', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        const product = result.rows[0];

        // 3. Ecriture dans le cache
        if (redisClient.isReady) {
            try {
                await redisClient.set(cacheKey, JSON.stringify(product), { EX: 60 });
            } catch (redisErr) {
                console.error('redis set error:', redisErr);
            }
        }

        res.json(product);
    } catch (err) {
        console.error(err);
        try {
            // Fallback sur le replica si le cache foire
            const result = await poolReplica.query('SELECT * FROM products WHERE id = $1', [id]);
            if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });

            res.json(result.rows[0]);
        } catch (dbErr) {
            res.status(500).json({ error: dbErr.message });
        }
    }
});

// PUT /products/:id - Modification d'un produit
app.put('/products/:id', async (req, res) => {
    const { id } = req.params;
    const { name, price_cents } = req.body;
    const cacheKey = `product:${id}`;

    try {
        // 1. BDD Principale
        const result = await poolPrimary.query(
            'UPDATE products SET name = $1, price_cents = $2 WHERE id = $3 RETURNING *',
            [name, price_cents, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        // 2. Réinitialiser le cache
        if (redisClient.isReady) {
            try {
                await redisClient.del(cacheKey);
                console.log(`deleted cached value at ${cacheKey}`);
            } catch (redisErr) {
                console.error('redis cache delete error: ', redisErr);
            }
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Lancer express.js
app.listen(port, () => {
    console.log(`API running on port ${port}`);
});
