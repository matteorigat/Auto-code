import sqlite3
import os

db_path = os.path.join(os.path.dirname(__file__), "metrics.db")
print(f"Connecting to database at {db_path}...")
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Start a transaction
cursor.execute("BEGIN TRANSACTION;")

try:
    # 1. Update model_calls
    print("Updating model_calls...")
    cursor.execute("""
        UPDATE model_calls 
        SET provider = 'groq', model = 'groq/llama-3.1-8b-instant' 
        WHERE model = 'litellm/llama-3.1-8b-instant';
    """)
    cursor.execute("""
        UPDATE model_calls 
        SET provider = 'openrouter', model = 'openrouter/owl-alpha' 
        WHERE model = 'litellm/owl-alpha';
    """)
    print("model_calls updated.")

    # 2. Update daily_agg with merge logic to avoid Primary Key conflicts
    print("Updating daily_agg...")
    cursor.execute("SELECT date, provider, model, calls, input_tokens, output_tokens, total_tokens, cost, errors FROM daily_agg;")
    rows = cursor.fetchall()

    for row in rows:
        date, provider, model, calls, input_tokens, output_tokens, total_tokens, cost, errors = row
        new_provider = provider
        new_model = model

        if model == 'litellm/llama-3.1-8b-instant':
            new_provider = 'groq'
            new_model = 'groq/llama-3.1-8b-instant'
        elif model == 'litellm/owl-alpha':
            new_provider = 'openrouter'
            new_model = 'openrouter/owl-alpha'
        else:
            continue # Already migrated or other

        # Check if the new primary key already exists
        cursor.execute("SELECT calls, input_tokens, output_tokens, total_tokens, cost, errors FROM daily_agg WHERE date = ? AND provider = ? AND model = ?;", (date, new_provider, new_model))
        existing = cursor.fetchone()

        if existing:
            # Merge statistics
            cursor.execute("""
                UPDATE daily_agg 
                SET calls = calls + ?, 
                    input_tokens = input_tokens + ?, 
                    output_tokens = output_tokens + ?, 
                    total_tokens = total_tokens + ?, 
                    cost = cost + ?, 
                    errors = errors + ?
                WHERE date = ? AND provider = ? AND model = ?;
            """, (calls, input_tokens, output_tokens, total_tokens, cost, errors, date, new_provider, new_model))
            
            # Delete the old record
            cursor.execute("DELETE FROM daily_agg WHERE date = ? AND provider = ? AND model = ?;", (date, provider, model))
        else:
            # Safely update provider and model
            cursor.execute("""
                UPDATE daily_agg 
                SET provider = ?, model = ? 
                WHERE date = ? AND provider = ? AND model = ?;
            """, (new_provider, new_model, date, provider, model))

    print("daily_agg updated and merged successfully.")
    conn.commit()
    print("Migration completed successfully!")
except Exception as e:
    conn.rollback()
    print(f"Migration failed: {e}")
finally:
    conn.close()
