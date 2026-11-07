export class ConnectionPoolError extends Error {
    code;
    constructor(code, message = code) {
        super(message);
        this.code = code;
        this.name = "ConnectionPoolError";
    }
}
