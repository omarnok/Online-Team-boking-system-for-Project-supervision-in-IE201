from flask import Flask, request, jsonify
import requests
import os

app = Flask(__name__)

# ==================== CONFIGURE THESE ====================
TELEGRAM_BOT_TOKEN = "YOUR_BOT_TOKEN_FROM_BOTFATHER"
ADMIN_TELEGRAM_ID = "YOUR_NUMERIC_TELEGRAM_ID"  # From @userinfobot
# =======================================================

def send_telegram(chat_id, message):
    """Send a Telegram message."""
    if not chat_id or not TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN == "YOUR_BOT_TOKEN_FROM_BOTFATHER":
        return False
    
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        payload = {
            'chat_id': str(chat_id),
            'text': message,
            'parse_mode': 'HTML'
        }
        resp = requests.post(url, json=payload, timeout=10)
        return resp.ok
    except Exception as e:
        print(f"Telegram error: {e}")
        return False

@app.route('/webhook/booking', methods=['POST'])
def webhook_booking():
    """Called by frontend when a booking is made."""
    data = request.json
    
    team_name = data.get('team_name', 'Unknown')
    professor_name = data.get('professor_name', 'Unknown')
    slot_time = data.get('slot_time', 'Unknown')
    team_telegram = data.get('team_telegram', '')
    project = data.get('project', 'N/A')
    is_duplicate = data.get('is_duplicate', False)
    
    # 1. Notify team
    if team_telegram:
        team_msg = f"""? <b>Consultation {'Pending' if is_duplicate else 'Confirmed'}</b>

Team: {team_name}
Professor: {professor_name}
Time: {slot_time}
Project: {project}

{'? Waiting for professor approval (duplicate request).' if is_duplicate else 'Please arrive 5 minutes early.'}"""
        send_telegram(team_telegram, team_msg)
    
    # 2. Notify admin
    admin_msg = f"""?? <b>New Booking</b>

Team: {team_name}
Professor: {professor_name}
Time: {slot_time}
Project: {project}
Status: {'PENDING (duplicate)' if is_duplicate else 'CONFIRMED'}"""
    send_telegram(ADMIN_TELEGRAM_ID, admin_msg)
    
    return jsonify({"ok": True})

@app.route('/webhook/feedback', methods=['POST'])
def webhook_feedback():
    """Called by frontend when feedback is submitted."""
    data = request.json
    
    team_name = data.get('team_name', 'Unknown')
    professor_name = data.get('professor_name', 'Unknown')
    rating = data.get('rating', 0)
    feedback_text = data.get('feedback_text', '')
    
    stars = "?" * int(rating)
    
    message = f"""?? <b>New Feedback</b>

Team: {team_name}
Professor: {professor_name}
Rating: {stars} ({rating}/5)

{feedback_text}"""
    
    send_telegram(ADMIN_TELEGRAM_ID, message)
    return jsonify({"ok": True})

@app.route('/webhook/cancel', methods=['POST'])
def webhook_cancel():
    """Called by frontend when a booking is cancelled."""
    data = request.json
    
    team_name = data.get('team_name', 'Unknown')
    team_telegram = data.get('team_telegram', '')
    slot_time = data.get('slot_time', 'Unknown')
    
    if team_telegram:
        message = f"""? <b>Booking Cancelled</b>

Your consultation for team {team_name} at {slot_time} has been cancelled by the professor."""
        send_telegram(team_telegram, message)
    
    return jsonify({"ok": True})

if __name__ == "__main__":
    print("=" * 50)
    print("Telegram Webhook Server")
    print("=" * 50)
    print("This server handles Telegram notifications only.")
    print("Your frontend (index.html, etc.) stays unchanged.")
    print("=" * 50)
    print("\n??  Set TELEGRAM_BOT_TOKEN and ADMIN_TELEGRAM_ID in this file!")
    print("=" * 50)
    app.run(host="0.0.0.0", port=5001, debug=True)