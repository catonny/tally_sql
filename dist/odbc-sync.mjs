import { Pool } from 'pg';
import odbc from 'odbc';
function normalizeTablesList(lst) {
    if (!lst)
        return [];
    return lst
        .map((item) => item.trim())
        .filter((item, index, arr) => item.length > 0 && arr.indexOf(item) === index);
}
export function buildOdbcConnectionString(config) {
    if (config.connectionString && config.connectionString.trim().length > 0) {
        return config.connectionString.trim();
    }
    const dsn = config.dsn?.trim();
    if (!dsn || dsn.length === 0) {
        throw new Error('Either DSN or full connection string must be provided for ODBC connection.');
    }
    const parts = [`DSN=${dsn}`];
    if (config.username && config.username.trim().length > 0) {
        parts.push(`UID=${config.username.trim()}`);
    }
    if (config.password && config.password.trim().length > 0) {
        parts.push(`PWD=${config.password.trim()}`);
    }
    return parts.join(';');
}
export async function testOdbcConnection(config) {
    const connString = buildOdbcConnectionString(config);
    const connection = await odbc.connect(connString);
    try {
        const result = await connection.tables(undefined, undefined, '%', '%');
        const tables = [];
        for (const row of result) {
            const tableName = (row.TABLE_NAME || '').trim();
            const tableType = (row.TABLE_TYPE || '').toUpperCase();
            if (!tableName)
                continue;
            if (tableType === 'TABLE' || tableType === 'VIEW' || tableType === '') {
                if (!tables.includes(tableName))
                    tables.push(tableName);
            }
        }
        tables.sort((a, b) => a.localeCompare(b));
        return tables;
    }
    finally {
        await connection.close();
    }
}
export async function testPostgresConnection(config) {
    const pool = new Pool({
        host: config.host,
        port: config.port || 5432,
        database: config.database,
        user: config.user,
        password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    });
    try {
        const client = await pool.connect();
        try {
            await client.query('SELECT 1');
        }
        finally {
            client.release();
        }
    }
    finally {
        await pool.end();
    }
}
function quoteIdentifier(name) {
    return '"' + name.replace(/"/g, '""') + '"';
}
function schemaQualifiedName(schema, table) {
    return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}
function mapOdbcTypeToPg(typeCode) {
    if (typeCode === undefined || typeCode === null)
        return 'TEXT';
    const map = {
        [-7]: 'BOOLEAN',
        [-6]: 'SMALLINT',
        [-5]: 'BIGINT',
        [-4]: 'BYTEA',
        [-3]: 'BYTEA',
        [-2]: 'BYTEA',
        [-1]: 'TEXT',
        [0]: 'TEXT',
        [1]: 'TEXT',
        [2]: 'NUMERIC',
        [3]: 'NUMERIC',
        [4]: 'INTEGER',
        [5]: 'SMALLINT',
        [6]: 'REAL',
        [7]: 'REAL',
        [8]: 'DOUBLE PRECISION',
        [9]: 'DATE',
        [10]: 'TIME',
        [11]: 'TIMESTAMP',
        [12]: 'TEXT',
        [91]: 'DATE',
        [92]: 'TIME',
        [93]: 'TIMESTAMP',
    };
    return map[typeCode] || 'TEXT';
}
function inferPgTypeFromValue(value) {
    if (value === null || value === undefined)
        return 'TEXT';
    if (typeof value === 'boolean')
        return 'BOOLEAN';
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'BIGINT' : 'DOUBLE PRECISION';
    }
    if (value instanceof Date)
        return 'TIMESTAMP';
    if (value instanceof Buffer)
        return 'BYTEA';
    return 'TEXT';
}
function prepareValueForPg(value, pgType) {
    if (value === null || value === undefined)
        return null;
    switch (pgType) {
        case 'BOOLEAN':
            if (typeof value === 'boolean')
                return value;
            if (typeof value === 'number')
                return value !== 0;
            if (typeof value === 'string')
                return value.trim().toLowerCase() === 'true' || value.trim() === '1';
            return Boolean(value);
        case 'INTEGER':
        case 'SMALLINT':
        case 'BIGINT': {
            const parsedInt = typeof value === 'number' ? value : parseInt(value, 10);
            return isNaN(parsedInt) ? null : parsedInt;
        }
        case 'DOUBLE PRECISION':
        case 'REAL':
        case 'NUMERIC': {
            const parsedFloat = typeof value === 'number' ? value : parseFloat(value);
            return isNaN(parsedFloat) ? null : parsedFloat;
        }
        case 'DATE':
        case 'TIMESTAMP': {
            if (value instanceof Date)
                return value;
            const parsedDate = new Date(value);
            return isNaN(parsedDate.getTime()) ? null : parsedDate;
        }
        case 'TIME':
            return typeof value === 'string' ? value : value?.toString() || null;
        case 'BYTEA':
            if (value instanceof Buffer)
                return value;
            if (typeof value === 'string')
                return Buffer.from(value, 'binary');
            return null;
        default:
            return value?.toString() ?? null;
    }
}
class PostgresTarget {
    config;
    pool;
    schema;
    constructor(config) {
        this.config = config;
        this.schema = config.schema && config.schema.trim().length > 0 ? config.schema.trim() : 'public';
        this.pool = new Pool({
            host: config.host,
            port: config.port || 5432,
            database: config.database,
            user: config.user,
            password: config.password,
            ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        });
    }
    async init() {
        await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schema)}`);
    }
    async close() {
        await this.pool.end();
    }
    async ensureTable(tableName, columns) {
        const existingColumns = await this.pool.query('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', [this.schema, tableName]);
        const schemaTable = schemaQualifiedName(this.schema, tableName);
        if (existingColumns.rowCount === 0) {
            const columnDefinitions = columns.map((column) => `${quoteIdentifier(column.name)} ${column.pgType}`).join(', ');
            const createSql = `CREATE TABLE ${schemaTable} (${columnDefinitions})`;
            await this.pool.query(createSql);
        }
        else {
            const existingSet = new Set(existingColumns.rows.map((row) => row.column_name.toLowerCase()));
            for (const column of columns) {
                if (!existingSet.has(column.name.toLowerCase())) {
                    await this.pool.query(`ALTER TABLE ${schemaTable} ADD COLUMN ${quoteIdentifier(column.name)} ${column.pgType}`);
                }
            }
        }
    }
    async replaceTableData(tableName, columns, rows, truncate) {
        if (rows.length === 0)
            return 0;
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            if (truncate) {
                await client.query(`TRUNCATE TABLE ${schemaQualifiedName(this.schema, tableName)} RESTART IDENTITY`);
            }
            const quotedColumns = columns.map((column) => quoteIdentifier(column.name));
            const placeholders = columns.map((_, idx) => `$${idx + 1}`);
            const insertSql = `INSERT INTO ${schemaQualifiedName(this.schema, tableName)} (${quotedColumns.join(', ')}) VALUES (${placeholders.join(', ')})`;
            for (const row of rows) {
                const values = columns.map((column) => prepareValueForPg(row[column.name], column.pgType));
                await client.query(insertSql, values);
            }
            await client.query('COMMIT');
            return rows.length;
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
    }
}
export class OdbcReplicator {
    config;
    logger;
    odbcConnection;
    postgresTarget;
    running = false;
    constructor(config, logger = console.log) {
        this.config = {
            ...config,
            odbc: {
                ...config.odbc,
                tables: normalizeTablesList(config.odbc.tables),
            },
            sync: {
                realtime: config.sync.realtime,
                intervalSeconds: Math.max(config.sync.intervalSeconds || 0, 0),
                truncateBeforeInsert: config.sync.truncateBeforeInsert,
            },
        };
        this.logger = logger;
    }
    log(message) {
        const formatted = `[${new Date().toLocaleString()}] ${message}`;
        if (this.logger)
            this.logger(formatted);
    }
    async ensureConnections() {
        if (!this.odbcConnection) {
            const connString = buildOdbcConnectionString(this.config.odbc);
            this.log('Connecting to Tally ODBC source...');
            this.odbcConnection = await odbc.connect(connString);
            this.log('Connected to Tally ODBC source');
        }
        if (!this.postgresTarget) {
            this.log('Connecting to PostgreSQL database...');
            this.postgresTarget = new PostgresTarget(this.config.postgres);
            await this.postgresTarget.init();
            this.log('Connected to PostgreSQL database');
        }
    }
    async close() {
        if (this.odbcConnection) {
            await this.odbcConnection.close();
            this.odbcConnection = undefined;
        }
        if (this.postgresTarget) {
            await this.postgresTarget.close();
            this.postgresTarget = undefined;
        }
    }
    async getTablesToProcess() {
        if (this.config.odbc.tables && this.config.odbc.tables.length > 0) {
            return this.config.odbc.tables;
        }
        if (!this.odbcConnection)
            throw new Error('ODBC connection is not initialised.');
        const result = await this.odbcConnection.tables(undefined, undefined, '%', '%');
        const tables = [];
        for (const row of result) {
            const tableName = (row.TABLE_NAME || '').trim();
            const tableType = (row.TABLE_TYPE || '').toUpperCase();
            if (!tableName)
                continue;
            if (tableType === 'TABLE' || tableType === 'VIEW' || tableType === '') {
                if (!tables.includes(tableName))
                    tables.push(tableName);
            }
        }
        tables.sort((a, b) => a.localeCompare(b));
        return tables;
    }
    convertColumnDefinitions(metadata, sampleRow) {
        const columnMap = new Map();
        for (const column of metadata) {
            const name = (column.COLUMN_NAME || '').trim();
            if (!name)
                continue;
            const typeCode = typeof column.DATA_TYPE === 'number' ? column.DATA_TYPE : undefined;
            columnMap.set(name, { name, pgType: mapOdbcTypeToPg(typeCode), odbcType: typeCode });
        }
        if (columnMap.size === 0 && sampleRow) {
            for (const key of Object.keys(sampleRow)) {
                const value = sampleRow[key];
                columnMap.set(key, { name: key, pgType: inferPgTypeFromValue(value) });
            }
        }
        return Array.from(columnMap.values());
    }
    async fetchRows(tableName) {
        if (!this.odbcConnection)
            throw new Error('ODBC connection is not initialised.');
        const query = `SELECT * FROM ${quoteIdentifier(tableName)}`;
        const rawResult = await this.odbcConnection.query(query);
        if (Array.isArray(rawResult)) {
            return rawResult;
        }
        if (rawResult && typeof rawResult === 'object') {
            const resultAny = rawResult;
            if (typeof resultAny.fetchAll === 'function') {
                return await resultAny.fetchAll();
            }
            if (Array.isArray(resultAny.rows)) {
                return resultAny.rows;
            }
        }
        return [];
    }
    async cloneTable(tableName) {
        if (!this.odbcConnection || !this.postgresTarget)
            throw new Error('Connections are not initialised.');
        this.log(`Cloning table ${tableName}...`);
        const columnMetadata = await this.odbcConnection.columns(undefined, undefined, tableName, '%');
        const rows = await this.fetchRows(tableName);
        const columns = this.convertColumnDefinitions(columnMetadata, rows[0]);
        if (columns.length === 0) {
            this.log(`Skipping table ${tableName}: no columns discovered.`);
            return;
        }
        await this.postgresTarget.ensureTable(tableName, columns);
        const rowCount = await this.postgresTarget.replaceTableData(tableName, columns, rows, this.config.sync.truncateBeforeInsert);
        this.log(`Table ${tableName} synced (${rowCount} rows).`);
    }
    async runOnce() {
        if (this.running) {
            this.log('A sync operation is already in progress. Skipping this trigger.');
            return;
        }
        this.running = true;
        try {
            await this.ensureConnections();
            const tables = await this.getTablesToProcess();
            if (tables.length === 0) {
                this.log('No tables found to sync.');
                return;
            }
            this.log(`Starting sync for ${tables.length} table(s).`);
            for (const tableName of tables) {
                try {
                    await this.cloneTable(tableName);
                }
                catch (err) {
                    const errMessage = err instanceof Error ? err.message : String(err);
                    this.log(`Error syncing table ${tableName}: ${errMessage}`);
                }
            }
            this.log('Sync completed successfully.');
        }
        finally {
            this.running = false;
        }
    }
}
//# sourceMappingURL=odbc-sync.mjs.map