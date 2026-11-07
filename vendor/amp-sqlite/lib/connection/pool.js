import { ConnectionPoolError } from "./types.js";
export function createConnectionPool(options) {
    if (!Number.isSafeInteger(options.maxConnections) || options.maxConnections < 1) {
        throw new RangeError("maxConnections must be a positive safe integer");
    }
    const all = new Set();
    const idle = [];
    let closed = false;
    let nextId = 1;
    function assertPoolOpen() {
        if (closed)
            throw new ConnectionPoolError("pool_closed");
    }
    function assertConnectionActive(connection) {
        assertPoolOpen();
        if (connection.released)
            throw new ConnectionPoolError("connection_released");
    }
    function makeConnection(driver) {
        let released = false;
        let activeTransaction;
        const connection = {
            id: nextId++,
            driver,
            activate() { released = false; },
            get released() { return released; },
            startTransaction() {
                assertConnectionActive(connection);
                if (activeTransaction?.state === "active") {
                    throw new ConnectionPoolError("transaction_closed", "connection already has an active transaction");
                }
                driver.exec("BEGIN IMMEDIATE");
                let state = "active";
                const savepoints = [];
                let nextSavepoint = 1;
                const assertActive = () => {
                    assertConnectionActive(connection);
                    if (state !== "active")
                        throw new ConnectionPoolError("transaction_closed");
                };
                const assertTop = (point) => {
                    if (savepoints.at(-1) !== point)
                        throw new Error("savepoints must be operated in LIFO order");
                };
                const transaction = {
                    get state() { return state; },
                    connection,
                    query(statement) {
                        assertActive();
                        return driver.query(statement);
                    },
                    run(statement) {
                        assertActive();
                        return driver.run(statement);
                    },
                    exec(sql) {
                        assertActive();
                        driver.exec(sql);
                    },
                    savePoint(name) {
                        assertActive();
                        const pointName = name ?? `sp_${nextSavepoint++}`;
                        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(pointName))
                            throw new TypeError("invalid savepoint name");
                        driver.exec(`SAVEPOINT ${pointName}`);
                        let pointActive = true;
                        const point = {
                            name: pointName,
                            get active() { return pointActive; },
                            deactivate() { pointActive = false; },
                            release() {
                                assertActive();
                                if (!pointActive)
                                    throw new ConnectionPoolError("savepoint_closed");
                                assertTop(point);
                                driver.exec(`RELEASE SAVEPOINT ${pointName}`);
                                savepoints.pop();
                                pointActive = false;
                            },
                            rollback() {
                                assertActive();
                                if (!pointActive)
                                    throw new ConnectionPoolError("savepoint_closed");
                                assertTop(point);
                                driver.exec(`ROLLBACK TO SAVEPOINT ${pointName}`);
                                driver.exec(`RELEASE SAVEPOINT ${pointName}`);
                                savepoints.pop();
                                pointActive = false;
                            },
                        };
                        savepoints.push(point);
                        return point;
                    },
                    commit() {
                        assertActive();
                        if (savepoints.length > 0)
                            throw new Error("cannot commit with active savepoints");
                        driver.exec("COMMIT");
                        state = "committed";
                    },
                    rollback() {
                        assertActive();
                        driver.exec("ROLLBACK");
                        state = "rolled_back";
                        for (const point of savepoints)
                            point.deactivate();
                        savepoints.length = 0;
                    },
                };
                activeTransaction = transaction;
                return transaction;
            },
            release() {
                if (released)
                    return;
                if (activeTransaction?.state === "active")
                    activeTransaction.rollback();
                released = true;
                idle.push(connection);
            },
        };
        return connection;
    }
    return {
        acquire() {
            assertPoolOpen();
            const reused = idle.pop();
            if (reused) {
                reused.activate();
                return reused;
            }
            if (all.size >= options.maxConnections)
                throw new ConnectionPoolError("pool_exhausted");
            const driver = options.open();
            const connection = makeConnection(driver);
            all.add(connection);
            return connection;
        },
        withConnection(work) {
            const connection = this.acquire();
            try {
                return work(connection);
            }
            finally {
                connection.release();
            }
        },
        withTransaction(work) {
            const connection = this.acquire();
            const transaction = connection.startTransaction();
            try {
                const result = work(transaction);
                transaction.commit();
                return result;
            }
            catch (error) {
                if (transaction.state === "active")
                    transaction.rollback();
                throw error;
            }
            finally {
                connection.release();
            }
        },
        stats() {
            return Object.freeze({ size: all.size, idle: idle.length, leased: all.size - idle.length, maxConnections: options.maxConnections, closed });
        },
        close() {
            if (closed)
                return;
            if (idle.length !== all.size)
                throw new Error("cannot close pool while connections are leased");
            for (const connection of all)
                connection.driver.close();
            idle.length = 0;
            all.clear();
            closed = true;
        },
    };
}
