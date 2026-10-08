<?php
/**
 * BookInn - Database-backed PHP session handler
 *
 * Vercel's serverless PHP runtime spins up a fresh, isolated function
 * instance per request (or reuses one briefly, with no guarantee of
 * sharing disk state between invocations). PHP's default session
 * storage writes session data to local files, which does not work
 * across stateless/ephemeral serverless instances -- a login on one
 * invocation would be invisible to the very next request.
 *
 * This class implements SessionHandlerInterface backed by the
 * APP_SESSION table instead, so session state is shared through the
 * same Postgres/Supabase database every request already connects to.
 */
class DbSessionHandler implements SessionHandlerInterface {
    private PDO $pdo;
    private int $maxLifetime;

    public function __construct(PDO $pdo, int $maxLifetime = 1440) {
        $this->pdo = $pdo;
        $this->maxLifetime = $maxLifetime;
    }

    public function open(string $path, string $name): bool {
        return true;
    }

    public function close(): bool {
        return true;
    }

    public function read(string $id): string|false {
        try {
            $stmt = $this->pdo->prepare('SELECT DATA FROM APP_SESSION WHERE SESSION_ID = :id');
            $stmt->execute([':id' => $id]);
            $data = $stmt->fetchColumn();
            return $data === false ? '' : $data;
        } catch (Throwable $e) {
            return '';
        }
    }

    public function write(string $id, string $data): bool {
        try {
            // Upsert: Postgres-native ON CONFLICT, avoids a separate
            // SELECT-then-INSERT/UPDATE round trip and race condition.
            $stmt = $this->pdo->prepare(
                'INSERT INTO APP_SESSION (SESSION_ID, DATA, LAST_ACCESS)
                 VALUES (:id, :data, CURRENT_TIMESTAMP)
                 ON CONFLICT (SESSION_ID)
                 DO UPDATE SET DATA = :data2, LAST_ACCESS = CURRENT_TIMESTAMP'
            );
            $stmt->execute([':id' => $id, ':data' => $data, ':data2' => $data]);
            return true;
        } catch (Throwable $e) {
            return false;
        }
    }

    public function destroy(string $id): bool {
        try {
            $stmt = $this->pdo->prepare('DELETE FROM APP_SESSION WHERE SESSION_ID = :id');
            $stmt->execute([':id' => $id]);
            return true;
        } catch (Throwable $e) {
            return false;
        }
    }

    public function gc(int $max_lifetime): int|false {
        try {
            $stmt = $this->pdo->prepare(
                "DELETE FROM APP_SESSION WHERE LAST_ACCESS < (CURRENT_TIMESTAMP - (:seconds || ' seconds')::interval)"
            );
            $stmt->execute([':seconds' => $max_lifetime]);
            return $stmt->rowCount();
        } catch (Throwable $e) {
            return false;
        }
    }
}
