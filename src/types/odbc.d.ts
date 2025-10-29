declare module 'odbc' {
    export interface TableEntry {
        TABLE_NAME?: string;
        TABLE_SCHEM?: string | null;
        TABLE_TYPE?: string | null;
    }

    export interface ColumnsEntry {
        COLUMN_NAME?: string;
        DATA_TYPE?: number;
        TYPE_NAME?: string;
    }

    export interface Result<T = any> extends Array<T> {
        count: number;
        columns: ColumnsEntry[];
        statement?: string;
        parameters?: any[];
        fetchAll?: () => Promise<T[]>;
    }

    export interface Connection {
        query<T = any>(sql: string): Promise<Result<T> | T[]>;
        close(): Promise<void>;
        tables(catalog?: string | null, schema?: string | null, table?: string | null, type?: string | null): Promise<Result<TableEntry>>;
        columns(catalog?: string | null, schema?: string | null, table?: string | null, column?: string | null): Promise<Result<ColumnsEntry>>;
    }

    export function connect(connectionString: string): Promise<Connection>;
}
