// ==================== CONFIGURATION ====================
const SUPABASE_URL = 'https://riwnvkgpgnthgothfzoh.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpd252a2dwZ250aGdvdGhmem9oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4ODQxNTYsImV4cCI6MjA5MjQ2MDE1Nn0.xjQLBczNCaoC0egNLWw8c1_KfHy1p2PAqS9ZHcZMD18';

// Telegram webhook server (running locally or hosted)
const WEBHOOK_URL = 'http://localhost:5001/webhook';

const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let currentTeam = null;
let currentProf = null;
let selectedSlot = null;

// ==================== UTILITIES ====================
function fmtTime(isoString) {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
}
function fmtDate(dateStr) {
    return new Date(dateStr).toLocaleDateString();
}

function generateICS(slot, prof, team, type, loc) {
    const pad = n => n.toString().padStart(2,'0');
    const d = new Date(slot.start_time);
    const dt = `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
    const de = new Date(slot.end_time);
    const dte = `${de.getUTCFullYear()}${pad(de.getUTCMonth()+1)}${pad(de.getUTCDate())}T${pad(de.getUTCHours())}${pad(de.getUTCMinutes())}00Z`;
    
    return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//UniScheduler//EN
BEGIN:VEVENT
DTSTART:${dt}
DTEND:${dte}
DTSTAMP:${dt}
SUMMARY:Consultation with ${prof.name}
DESCRIPTION:Team ${team.display_name} project consultation
LOCATION:${type === 'online' ? 'Online' : loc}
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;
}

function downloadICS(filename, content) {
    const blob = new Blob([content], {type: 'text/calendar'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
}

// ==================== WEBHOOK HELPERS ====================
async function notifyWebhook(endpoint, payload) {
    try {
        await fetch(`${WEBHOOK_URL}/${endpoint}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.log('Webhook offline (expected if local):', e);
    }
}

// ==================== TEAM PORTAL ====================
async function identifyTeam() {
    const sec = parseInt(document.getElementById('sectionNum').value);
    const team = parseInt(document.getElementById('teamNum').value);
    const telegramId = document.getElementById('teamTelegram')?.value || '';
    
    if (!sec || !team) return alert('Enter section and team numbers');
    
    const displayName = `S${sec}T${team}`;
    
    const {data, error} = await db
        .from('teams')
        .upsert({
            section_number: sec, 
            team_number: team, 
            display_name: displayName,
            telegram_id: telegramId
        }, {onConflict: 'section_number,team_number'})
        .select().single();
    
    if (error) return alert('Error: ' + error.message);
    currentTeam = data;
    document.getElementById('teamDisplay').textContent = `Team: ${data.display_name}`;
    document.getElementById('bookingPanel').classList.remove('d-none');
    loadProfessors();
}

async function loadProfessors() {
    const {data} = await db.from('professors').select('*').order('name');
    const sel = document.getElementById('profSelect');
    sel.innerHTML = '<option value="">Select Professor</option>';
    data.forEach(p => sel.add(new Option(p.name, p.id)));
}

async function loadSlots() {
    const profId = document.getElementById('profSelect').value;
    const date = document.getElementById('dateSelect').value;
    const container = document.getElementById('slotsContainer');
    container.innerHTML = '';
    
    if (!profId || !date) return;
    
    const {data: slots} = await db
        .from('slots')
        .select('*, availability(consultation_type,location_details)')
        .eq('professor_id', profId)
        .eq('slot_date', date)
        .order('start_time');
    
    if (!slots || !slots.length) {
        container.innerHTML = '<div class="col-12"><div class="alert alert-info">No slots available for this date.</div></div>';
        return;
    }
    
    // Get reservations for these slots
    const {data: reservations} = await db
        .from('reservations')
        .select('*, team:teams(display_name,telegram_id)')
        .in('slot_id', slots.map(s => s.id))
        .neq('status', 'cancelled');
    
    // Get waiting list counts
    const {data: waiting} = await db
        .from('waiting_list')
        .select('*')
        .in('slot_id', slots.map(s => s.id))
        .eq('status', 'waiting');
    
    slots.forEach(slot => {
        const res = reservations?.find(r => r.slot_id === slot.id);
        const waitCount = waiting?.filter(w => w.slot_id === slot.id).length || 0;
        const type = slot.availability?.consultation_type || 'in-person';
        const loc = slot.availability?.location_details || 'TBD';
        
        const card = document.createElement('div');
        card.className = 'col-md-4';
        card.innerHTML = `
            <div class="card h-100 ${slot.is_booked ? 'border-warning' : 'border-success'}">
                <div class="card-body">
                    <h6 class="card-title">${fmtTime(slot.start_time)} - ${fmtTime(slot.end_time)}</h6>
                    <span class="badge bg-${type==='online'?'info':'secondary'} mb-2">${type}</span>
                    <p class="small text-muted mb-1">${loc}</p>
                    ${slot.is_booked ? `
                        <div class="alert alert-warning py-1 small">Booked by: ${res?.team?.display_name || 'Unknown'}</div>
                        <button onclick="joinWaitingList('${slot.id}')" class="btn btn-outline-warning btn-sm w-100">
                            Join Waiting List (${waitCount} waiting)
                        </button>
                    ` : `
                        <button onclick="preBook('${slot.id}', '${type}', '${loc}')" class="btn btn-success btn-sm w-100">
                            Book Slot
                        </button>
                    `}
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

async function preBook(slotId, type, loc) {
    selectedSlot = {id: slotId, type, loc};
    const {data: slot} = await db.from('slots').select('*, professor:professors(*), availability(*)').eq('id', slotId).single();
    selectedSlot.details = slot;
    
    // Check for existing confirmed booking with THIS professor
    const {data: existingSameProf} = await db
        .from('reservations')
        .select('*, slot:slots(slot_date)')
        .eq('team_id', currentTeam.id)
        .eq('professor_id', slot.professor_id)
        .eq('slot.slot_date', slot.slot_date)
        .eq('status', 'confirmed');
    
    // Check for existing confirmed booking with ANY professor
    const {data: existingAnyProf} = await db
        .from('reservations')
        .select('*, professor:professors(name), slot:slots(*)')
        .eq('team_id', currentTeam.id)
        .eq('status', 'confirmed');
    
    document.getElementById('modalTeam').textContent = currentTeam.display_name;
    document.getElementById('modalTime').textContent = `${fmtDate(slot.slot_date)} ${fmtTime(slot.start_time)} - ${fmtTime(slot.end_time)}`;
    document.getElementById('modalType').textContent = `${type} (${loc})`;
    
    const dupWarn = document.getElementById('duplicateWarning');
    
    if (existingSameProf && existingSameProf.length > 0) {
        // Same professor, same day = always pending
        dupWarn.innerHTML = `?? You already have a booking with this professor on this day. This request will be sent for professor approval.`;
        dupWarn.classList.remove('d-none');
        selectedSlot.isDuplicate = true;
        selectedSlot.duplicateType = 'same-day';
    } else if (existingAnyProf && existingAnyProf.length > 0) {
        // Different professor = check for override
        const otherProf = existingAnyProf[0].professor;
        const {data: override} = await db
            .from('registration_overrides')
            .select('*')
            .eq('team_id', currentTeam.id)
            .eq('professor_id', slot.professor_id)
            .single();
        
        if (!override) {
            dupWarn.innerHTML = `?? You are already booked with Professor ${otherProf.name}. You need professor permission to book with multiple professors. <a href="/waitlist.html?prof=${slot.professor_id}" class="alert-link">Join waiting list instead</a>.`;
            dupWarn.classList.remove('d-none');
            selectedSlot.isDuplicate = true;
            selectedSlot.duplicateType = 'other-prof';
            selectedSlot.blocked = true;
        } else {
            dupWarn.classList.add('d-none');
            selectedSlot.isDuplicate = false;
            selectedSlot.blocked = false;
        }
    } else {
        dupWarn.classList.add('d-none');
        selectedSlot.isDuplicate = false;
        selectedSlot.blocked = false;
    }
    
    new bootstrap.Modal(document.getElementById('bookModal')).show();
}

async function confirmBooking() {
    if (selectedSlot.blocked) {
        alert('You cannot book without professor permission. Join the waiting list instead.');
        bootstrap.Modal.getInstance(document.getElementById('bookModal')).hide();
        return;
    }
    
    const slot = selectedSlot.details;
    
    const insert = {
        slot_id: slot.id,
        team_id: currentTeam.id,
        professor_id: slot.professor_id,
        status: selectedSlot.isDuplicate ? 'pending' : 'confirmed',
        is_duplicate: selectedSlot.isDuplicate
    };
    
    const {error} = await db.from('reservations').insert(insert);
    if (error) return alert('Booking failed: ' + error.message);
    
    if (!selectedSlot.isDuplicate) {
        await db.from('slots').update({is_booked: true}).eq('id', slot.id);
    }
    
    bootstrap.Modal.getInstance(document.getElementById('bookModal')).hide();
    
    // Send Telegram notification via webhook
    await notifyWebhook('booking', {
        team_name: currentTeam.display_name,
        professor_name: slot.professor.name,
        slot_time: `${fmtDate(slot.slot_date)} ${fmtTime(slot.start_time)}`,
        team_telegram: currentTeam.telegram_id,
        project: currentTeam.project || 'N/A',
        is_duplicate: selectedSlot.isDuplicate
    });
    
    const msg = selectedSlot.isDuplicate 
        ? 'Duplicate request submitted for professor approval.' 
        : 'Booking confirmed! Check your Telegram.';
    
    alert(msg);
    
    if (!selectedSlot.isDuplicate) {
        if (confirm('Download calendar invite (.ics)?')) {
            const icsContent = generateICS(slot, slot.professor, currentTeam, selectedSlot.type, selectedSlot.loc);
            downloadICS(`consultation-${currentTeam.display_name}.ics`, icsContent);
        }
    }
    
    loadSlots();
}

async function joinWaitingList(slotId) {
    const {error} = await db.from('waiting_list').insert({
        slot_id: slotId,
        team_id: currentTeam.id,
        status: 'waiting'
    });
    if (error) return alert('Already on waiting list or error: ' + error.message);
    alert('Added to waiting list!');
    loadSlots();
}

// ==================== LOOKUP & FEEDBACK ====================
async function lookupTeam() {
    const urlParams = new URLSearchParams(window.location.search);
    const sec = urlParams.get('section');
    const teamNum = urlParams.get('team');
    
    if (!sec || !teamNum) return;
    
    const {data: teams} = await db
        .from('teams')
        .select('*, reservations(*, slot:slots(*), professor:professors(name))')
        .eq('section_number', sec)
        .eq('team_number', teamNum);
    
    if (!teams || !teams.length) {
        document.getElementById('lookupResult').innerHTML = '<div class="alert alert-warning">No bookings found.</div>';
        return;
    }
    
    const team = teams[0];
    let html = `<h4>${team.display_name}</h4>`;
    
    if (team.reservations && team.reservations.length > 0) {
        team.reservations.forEach(r => {
            if (r.status === 'cancelled') return;
            html += `
                <div class="card mb-2">
                    <div class="card-body">
                        <p><strong>Professor:</strong> ${r.professor?.name || 'Unknown'}</p>
                        <p><strong>Date:</strong> ${fmtDate(r.slot?.slot_date)} ${fmtTime(r.slot?.start_time)} - ${fmtTime(r.slot?.end_time)}</p>
                        <p><strong>Status:</strong> <span class="badge bg-${r.status === 'confirmed' ? 'success' : 'warning'}">${r.status}</span></p>
                        ${r.status === 'confirmed' ? `
                            <button onclick="openFeedback('${r.id}', '${r.professor_id}', '${r.slot_id}')" class="btn btn-sm btn-primary">Submit Feedback</button>
                            <button onclick="downloadBookingICS('${r.slot_id}')" class="btn btn-sm btn-outline-secondary">?? Calendar</button>
                        ` : ''}
                    </div>
                </div>
            `;
        });
    } else {
        html += '<p>No active bookings.</p>';
    }
    
    document.getElementById('lookupResult').innerHTML = html;
}

function openFeedback(resId, profId, slotId) {
    document.getElementById('feedbackResId').value = resId;
    document.getElementById('feedbackProfId').value = profId;
    document.getElementById('feedbackSlotId').value = slotId;
    new bootstrap.Modal(document.getElementById('feedbackModal')).show();
}

async function submitFeedback() {
    const resId = document.getElementById('feedbackResId').value;
    const profId = document.getElementById('feedbackProfId').value;
    const slotId = document.getElementById('feedbackSlotId').value;
    const rating = parseInt(document.getElementById('feedbackRating').value);
    const text = document.getElementById('feedbackText').value;
    
    if (!rating) return alert('Please select a rating');
    
    const {error} = await db.from('feedback').insert({
        team_id: currentTeam?.id,
        professor_id: profId,
        slot_id: slotId,
        rating: rating,
        feedback_text: text
    });
    
    if (error) return alert('Error: ' + error.message);
    
    // Get professor name for webhook
    const {data: prof} = await db.from('professors').select('name').eq('id', profId).single();
    
    // Notify admin via webhook
    await notifyWebhook('feedback', {
        team_name: currentTeam?.display_name || 'Unknown',
        professor_name: prof?.name || 'Unknown',
        rating: rating,
        feedback_text: text
    });
    
    bootstrap.Modal.getInstance(document.getElementById('feedbackModal')).hide();
    alert('Feedback submitted! Thank you.');
    lookupTeam(); // Refresh
}

async function downloadBookingICS(slotId) {
    const {data: slot} = await db.from('slots').select('*, professor:professors(*), availability(*)').eq('id', slotId).single();
    if (!slot) return;
    
    const ics = generateICS(slot, slot.professor, currentTeam, slot.availability?.consultation_type || 'in-person', slot.availability?.location_details || '');
    downloadICS(`consultation-${currentTeam.display_name}.ics`, ics);
}

// ==================== PROFESSOR DASHBOARD ====================
async function profLogin() {
    const profId = document.getElementById('loginProf').value;
    const pin = document.getElementById('loginPin').value;
    
    const {data, error} = await db
        .from('professors')
        .select('*')
        .eq('id', profId)
        .eq('pin', pin)
        .single();
    
    if (error || !data) return alert('Invalid credentials');
    currentProf = data;
    document.getElementById('loginPanel').classList.add('d-none');
    document.getElementById('dashboardPanel').classList.remove('d-none');
    loadProfSlots();
    loadPending();
    loadWaiting();
}

async function addAvailability() {
    const date = document.getElementById('availDate').value;
    const type = document.getElementById('availType').value;
    const start = document.getElementById('availStart').value;
    const end = document.getElementById('availEnd').value;
    const loc = document.getElementById('availLoc').value;
    
    if (!date || !start || !end) return alert('Fill all fields');
    
    const {data: avail, error} = await db
        .from('availability')
        .insert({professor_id: currentProf.id, date, consultation_type: type, start_time: start, end_time: end, location_details: loc})
        .select().single();
    
    if (error) return alert(error.message);
    
    const slots = [];
    const startDt = new Date(`${date}T${start}`);
    const endDt = new Date(`${date}T${end}`);
    const blockMs = 25 * 60 * 1000;
    const slotMs = 20 * 60 * 1000;
    
    let cur = new Date(startDt);
    while (cur.getTime() + slotMs <= endDt.getTime()) {
        slots.push({
            availability_id: avail.id,
            professor_id: currentProf.id,
            slot_date: date,
            start_time: new Date(cur).toISOString(),
            end_time: new Date(cur.getTime() + slotMs).toISOString()
        });
        cur = new Date(cur.getTime() + blockMs);
    }
    
    const {error: slotErr} = await db.from('slots').insert(slots);
    if (slotErr) return alert(slotErr.message);
    
    alert(`Created ${slots.length} slots`);
    loadProfSlots();
}

async function loadProfSlots() {
    const {data: slots} = await db
        .from('slots')
        .select('*, availability(consultation_type,location_details), reservations(*, team:teams(display_name,telegram_id))')
        .eq('professor_id', currentProf.id)
        .order('slot_date', {ascending: false})
        .order('start_time');
    
    const div = document.getElementById('profSlots');
    div.innerHTML = '';
    
    slots.forEach(s => {
        const res = s.reservations?.find(r => r.status !== 'cancelled');
        div.innerHTML += `
            <div class="col-md-6">
                <div class="card mb-2">
                    <div class="card-body py-2">
                        <div class="d-flex justify-content-between align-items-start">
                            <div>
                                <strong>${fmtDate(s.slot_date)}</strong> ${fmtTime(s.start_time)}-${fmtTime(s.end_time)}
                                <span class="badge bg-${s.availability?.consultation_type==='online'?'info':'secondary'}">${s.availability?.consultation_type || 'in-person'}</span>
                            </div>
                            <button onclick="deleteSlot('${s.id}')" class="btn btn-sm btn-outline-danger" title="Delete slot">???</button>
                        </div>
                        ${res ? `
                            <div class="small mt-1">
                                Booked by: ${res.team?.display_name} 
                                ${res.team?.telegram_id ? `<span class="badge bg-info">?? ${res.team.telegram_id}</span>` : ''}
                                ${res.status === 'pending' ? '<span class="badge bg-warning">PENDING</span>' : ''}
                                ${res.is_duplicate ? '<span class="badge bg-warning">[DUPLICATE]</span>' : ''}
                            </div>
                            <button onclick="cancelReservation('${res.id}', '${s.id}')" class="btn btn-sm btn-outline-danger mt-1">Cancel</button>
                            <button onclick="approveReservation('${res.id}')" class="btn btn-sm btn-outline-success mt-1 ${res.status === 'confirmed' ? 'd-none' : ''}">Approve</button>
                        ` : '<div class="small text-success mt-1">Free slot</div>'}
                    </div>
                </div>
            </div>
        `;
    });
}

async function deleteSlot(id) {
    if (!confirm('Delete this time slot? Any reservations or waiting-list entries for it will be removed automatically.')) return;
    const {error} = await db.from('slots').delete().eq('id', id);
    if (error) return alert('Error deleting slot: ' + error.message);
    loadProfSlots();
    loadWaiting();
}

async function cancelReservation(resId, slotId) {
    if (!confirm('Cancel this reservation? First waiting list entry will be auto-promoted.')) return;
    
    // Get team info before cancelling for notification
    const {data: res} = await db.from('reservations').select('*, team:teams(*)').eq('id', resId).single();
    
    await db.from('reservations').update({status: 'cancelled'}).eq('id', resId);
    await db.from('slots').update({is_booked: false}).eq('id', slotId);
    
    // Notify team via webhook
    if (res?.team?.telegram_id) {
        await notifyWebhook('cancel', {
            team_name: res.team.display_name,
            team_telegram: res.team.telegram_id,
            slot_time: `${fmtDate(res.slot?.slot_date)} ${fmtTime(res.slot?.start_time)}`
        });
    }
    
    // Auto-promote from waiting list
    const {data: waits} = await db
        .from('waiting_list')
        .select('*, team:teams(*)')
        .eq('slot_id', slotId)
        .eq('status', 'waiting')
        .order('requested_at')
        .limit(1);
    
    if (waits && waits.length > 0) {
        const w = waits[0];
        await db.from('reservations').insert({
            slot_id: slotId,
            team_id: w.team_id,
            professor_id: currentProf.id,
            status: 'confirmed'
        });
        await db.from('slots').update({is_booked: true}).eq('id', slotId);
        await db.from('waiting_list').update({status: 'accepted'}).eq('id', w.id);
        
        // Notify promoted team
        if (w.team?.telegram_id) {
            const {data: slot} = await db.from('slots').select('*, professor:professors(name)').eq('id', slotId).single();
            await notifyWebhook('booking', {
                team_name: w.team.display_name,
                professor_name: slot.professor.name,
                slot_time: `${fmtDate(slot.slot_date)} ${fmtTime(slot.start_time)}`,
                team_telegram: w.team.telegram_id,
                project: w.team.project || 'N/A',
                is_duplicate: false
            });
        }
        
        alert(`Auto-promoted team ${w.team.display_name} from waiting list!`);
    }
    
    loadProfSlots();
    loadWaiting();
}

async function approveReservation(resId) {
    const {data: res} = await db.from('reservations').select('*, slot:slots(*), team:teams(*), professor:professors(*)').eq('id', resId).single();
    
    await db.from('reservations').update({status: 'confirmed', is_duplicate: false}).eq('id', resId);
    await db.from('slots').update({is_booked: true}).eq('id', res.slot.id);
    
    // Notify team
    if (res?.team?.telegram_id) {
        await notifyWebhook('booking', {
            team_name: res.team.display_name,
            professor_name: res.professor.name,
            slot_time: `${fmtDate(res.slot.slot_date)} ${fmtTime(res.slot.start_time)}`,
            team_telegram: res.team.telegram_id,
            project: res.team.project || 'N/A',
            is_duplicate: false
        });
    }
    
    alert('Approved! Team notified via Telegram.');
    loadPending();
    loadProfSlots();
}

async function loadPending() {
    const {data} = await db
        .from('reservations')
        .select('*, team:teams(*), slot:slots(*)')
        .eq('professor_id', currentProf.id)
        .eq('status', 'pending');
    
    const div = document.getElementById('pendingList');
    div.innerHTML = '';
    
    if (!data || !data.length) {
        div.innerHTML = '<div class="list-group-item">No pending approvals</div>';
        return;
    }
    
    data.forEach(r => {
        div.innerHTML += `
            <div class="list-group-item d-flex justify-content-between align-items-center">
                <div>
                    <strong>${r.team.display_name}</strong> 
                    ${r.team.telegram_id ? `<span class="badge bg-info">?? ${r.team.telegram_id}</span>` : ''}
                    <br><small>${fmtDate(r.slot.slot_date)} ${fmtTime(r.slot.start_time)}</small>
                    ${r.is_duplicate ? '<br><span class="badge bg-warning">Duplicate request</span>' : ''}
                </div>
                <button onclick="approveReservation('${r.id}')" class="btn btn-sm btn-success">Approve</button>
            </div>
        `;
    });
}

async function loadWaiting() {
    const {data: slots, error: slotErr} = await db.from('slots').select('id').eq('professor_id', currentProf.id);
    if (slotErr || !slots || !slots.length) {
        document.getElementById('waitingList').innerHTML = '<div class="list-group-item">No waiting list entries</div>';
        return;
    }
    const slotIds = slots.map(s => s.id);
    
    const {data: waits, error} = await db
        .from('waiting_list')
        .select('*, team:teams(*), slot:slots(*)')
        .in('slot_id', slotIds)
        .eq('status', 'waiting')
        .order('requested_at');
    
    const div = document.getElementById('waitingList');
    div.innerHTML = '';
    
    if (error) {
        console.error(error);
        div.innerHTML = '<div class="list-group-item text-danger">Error loading waiting list</div>';
        return;
    }
    
    if (!waits || !waits.length) {
        div.innerHTML = '<div class="list-group-item">No waiting list entries</div>';
        return;
    }
    
    waits.forEach(w => {
        div.innerHTML += `
            <div class="list-group-item">
                <div class="d-flex justify-content-between">
                    <div>
                        <strong>${w.team.display_name}</strong>
                        ${w.team.telegram_id ? `<span class="badge bg-info">?? ${w.team.telegram_id}</span>` : ''}
                        <br><small>Waiting for ${fmtDate(w.slot.slot_date)} ${fmtTime(w.slot.start_time)}</small>
                    </div>
                    <span class="badge bg-secondary">${new Date(w.requested_at).toLocaleTimeString()}</span>
                </div>
            </div>
        `;
    });
}

function showTab(tabId) {
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.add('d-none'));
    document.getElementById(tabId).classList.remove('d-none');
    document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
    event.target.classList.add('active');
    if (tabId === 'tabSlots') loadProfSlots();
    if (tabId === 'tabPending') loadPending();
    if (tabId === 'tabWaiting') loadWaiting();
}

// ==================== ADMIN ====================
async function bulkImport() {
    const text = document.getElementById('csvInput').value.trim();
    if (!text) return;
    
    const lines = text.split('\n');
    const teams = [];
    for (let line of lines) {
        const [sec, team, telegramId] = line.split(',').map(s => s.trim());
        if (sec && team) {
            const displayName = `S${sec}T${team}`;
            teams.push({
                section_number: parseInt(sec), 
                team_number: parseInt(team), 
                display_name: displayName,
                telegram_id: telegramId || null
            });
        }
    }
    
    const {data, error} = await db.from('teams').upsert(teams, {onConflict: 'section_number,team_number'});
    document.getElementById('importResult').innerHTML = error 
        ? `<div class="alert alert-danger">Error: ${error.message}</div>`
        : `<div class="alert alert-success">Imported ${teams.length} teams!</div>`;
    loadAdminLists();
}

async function addProfessor() {
    const name = document.getElementById('newProfName').value.trim();
    const email = document.getElementById('newProfEmail').value.trim();
    const pin = document.getElementById('newProfPin').value.trim();
    const telegramId = document.getElementById('newProfTelegram')?.value?.trim() || '';
    
    if (!name || !email || !pin) {
        alert('Please fill in all required fields');
        return;
    }
    
    try {
        const {error} = await db.from('professors').insert({
            name, 
            email, 
            pin,
            telegram_id: telegramId || null
        });
        if (error) {
            alert('Database error: ' + error.message);
            console.error(error);
            return;
        }
        alert('Professor added successfully!');
        document.getElementById('newProfName').value = '';
        document.getElementById('newProfEmail').value = '';
        document.getElementById('newProfPin').value = '';
        if (document.getElementById('newProfTelegram')) document.getElementById('newProfTelegram').value = '';
        loadAdminLists();
    } catch (err) {
        console.error(err);
        alert('Unexpected error. Check the browser console (F12) for technical details.');
    }
}

async function deleteProfessor(id) {
    if (!confirm('Delete this professor? All their availability, slots, reservations, and waiting-list entries will be removed permanently.')) return;
    const {error} = await db.from('professors').delete().eq('id', id);
    if (error) return alert('Error deleting professor: ' + error.message);
    loadAdminLists();
}

async function deleteTeam(id) {
    if (!confirm('Delete this team? All their reservations and waiting-list entries will be removed permanently.')) return;
    const {error} = await db.from('teams').delete().eq('id', id);
    if (error) return alert('Error deleting team: ' + error.message);
    loadAdminLists();
}

async function loadAdminLists() {
    const profDiv = document.getElementById('profList');
    const teamDiv = document.getElementById('teamList');
    
    if (profDiv) {
        const {data: profs} = await db.from('professors').select('*').order('name');
        profDiv.innerHTML = '';
        if (!profs || !profs.length) {
            profDiv.innerHTML = '<div class="list-group-item text-muted">No professors yet</div>';
        } else {
            profs.forEach(p => {
                profDiv.innerHTML += `
                    <div class="list-group-item d-flex justify-content-between align-items-center">
                        <div>
                            <div class="fw-bold">${p.name}</div>
                            <div class="small text-muted">${p.email}</div>
                            ${p.telegram_id ? `<div class="small text-info">?? ${p.telegram_id}</div>` : ''}
                        </div>
                        <button onclick="deleteProfessor('${p.id}')" class="btn btn-sm btn-outline-danger">Delete</button>
                    </div>
                `;
            });
        }
    }
    
    if (teamDiv) {
        const {data: teams} = await db.from('teams').select('*').order('section_number').order('team_number');
        teamDiv.innerHTML = '';
        if (!teams || !teams.length) {
            teamDiv.innerHTML = '<div class="list-group-item text-muted">No teams yet</div>';
        } else {
            teams.forEach(t => {
                teamDiv.innerHTML += `
                    <div class="list-group-item d-flex justify-content-between align-items-center">
                        <div>
                            <div class="fw-bold">${t.display_name}</div>
                            <div class="small text-muted">${t.email || 'No email'}</div>
                            ${t.telegram_id ? `<div class="small text-info">?? ${t.telegram_id}</div>` : ''}
                        </div>
                        <button onclick="deleteTeam('${t.id}')" class="btn btn-sm btn-outline-danger">Delete</button>
                    </div>
                `;
            });
        }
    }
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
    if (document.getElementById('loginProf')) {
        const {data} = await db.from('professors').select('*').order('name');
        const sel = document.getElementById('loginProf');
        if (sel && data) data.forEach(p => sel.add(new Option(p.name, p.id)));
    }
    
    if (document.getElementById('profList')) {
        loadAdminLists();
    }
    
    // Lookup page init
    if (document.getElementById('lookupResult')) {
        lookupTeam();
    }
});