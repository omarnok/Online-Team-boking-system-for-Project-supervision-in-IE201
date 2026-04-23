// ==================== CONFIGURATION ====================
const SUPABASE_URL = 'https://riwnvkgpgnthgothfzoh.supabase.co'; // ← REPLACE THIS
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpd252a2dwZ250aGdvdGhmem9oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4ODQxNTYsImV4cCI6MjA5MjQ2MDE1Nn0.xjQLBczNCaoC0egNLWw8c1_KfHy1p2PAqS9ZHcZMD18'; // REPLACE THIS

const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

if (SUPABASE_URL.includes('YOUR_PROJECT_ID')) {
    console.error('WARNING: You must replace SUPABASE_URL and SUPABASE_KEY with your real values!');
}

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

// ==================== TEAM PORTAL ====================
async function identifyTeam() {
    const sec = parseInt(document.getElementById('sectionNum').value);
    const team = parseInt(document.getElementById('teamNum').value);
    const email = document.getElementById('teamEmail').value;
    
    if (!sec || !team) return alert('Enter section and team numbers');
    
    const {data, error} = await db
        .from('teams')
        .upsert({section_number: sec, team_number: team, email: email}, 
                {onConflict: 'section_number,team_number'})
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
    
    const {data: reservations} = await db
        .from('reservations')
        .select('*, team:teams(display_name)')
        .in('slot_id', slots.map(s => s.id))
        .neq('status', 'cancelled');
    
    const {data: waiting} = await db
        .from('waiting_list')
        .select('*')
        .in('slot_id', slots.map(s => s.id))
        .eq('status', 'waiting');
    
    slots.forEach(slot => {
        const res = reservations?.find(r => r.slot_id === slot.id);
        const waitCount = waiting?.filter(w => w.slot_id === slot.id).length || 0;
        const type = slot.availability.consultation_type;
        const loc = slot.availability.location_details;
        
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
    
    const {data: existing} = await db
        .from('reservations')
        .select('*, slot:slots(slot_date)')
        .eq('team_id', currentTeam.id)
        .eq('professor_id', slot.professor_id)
        .eq('slot.slot_date', slot.slot_date)
        .neq('status', 'cancelled');
    
    document.getElementById('modalTeam').textContent = currentTeam.display_name;
    document.getElementById('modalTime').textContent = `${fmtDate(slot.slot_date)} ${fmtTime(slot.start_time)} - ${fmtTime(slot.end_time)}`;
    document.getElementById('modalType').textContent = `${type} (${loc})`;
    
    const dupWarn = document.getElementById('duplicateWarning');
    if (existing && existing.length > 0) {
        dupWarn.classList.remove('d-none');
        selectedSlot.isDuplicate = true;
    } else {
        dupWarn.classList.add('d-none');
        selectedSlot.isDuplicate = false;
    }
    
    new bootstrap.Modal(document.getElementById('bookModal')).show();
}

async function confirmBooking() {
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
    
    const prof = slot.professor;
    const icsContent = generateICS(slot, prof, currentTeam, selectedSlot.type, selectedSlot.loc);
    
    const subject = encodeURIComponent(`Consultation Confirmed: ${currentTeam.display_name}`);
    const body = encodeURIComponent(`Team ${currentTeam.display_name},

Your consultation is ${selectedSlot.isDuplicate ? 'PENDING APPROVAL' : 'CONFIRMED'}:
Professor: ${prof.name}
Date: ${fmtDate(slot.slot_date)}
Time: ${fmtTime(slot.start_time)} - ${fmtTime(slot.end_time)}
Type: ${selectedSlot.type}
Location: ${selectedSlot.loc}

${selectedSlot.isDuplicate ? 'You will receive an email once the professor approves this duplicate request.' : 'Please arrive 5 minutes early.'}`);
    
    const mailto = `mailto:${currentTeam.email || ''}?subject=${subject}&body=${body}`;
    
    const msg = selectedSlot.isDuplicate 
        ? 'Duplicate request submitted for professor approval.' 
        : 'Booking confirmed!';
    
    alert(msg);
    
    if (!selectedSlot.isDuplicate) {
        if (confirm('Download calendar invite (.ics)?')) {
            downloadICS(`consultation-${currentTeam.display_name}.ics`, icsContent);
        }
        if (confirm('Open email template?')) {
            window.open(mailto, '_blank');
        }
    }
    
    loadSlots();
}

async function joinWaitingList(slotId) {
    const {error} = await db.from('waiting_list').insert({
        slot_id: slotId,
        team_id: currentTeam.id
    });
    if (error) return alert('Already on waiting list or error: ' + error.message);
    alert('Added to waiting list!');
    loadSlots();
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
        .select('*, availability(consultation_type,location_details), reservations(*, team:teams(display_name,email))')
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
                                <span class="badge bg-${s.availability.consultation_type==='online'?'info':'secondary'}">${s.availability.consultation_type}</span>
                            </div>
                            <button onclick="deleteSlot('${s.id}')" class="btn btn-sm btn-outline-danger" title="Delete slot">🗑️</button>
                        </div>
                        ${res ? `<div class="small mt-1">Booked by: ${res.team?.display_name} (${res.team?.email}) ${res.is_duplicate ? '<span class="text-warning">[PENDING]</span>' : ''}</div>` : '<div class="small text-success mt-1">Free slot</div>'}
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
    
    await db.from('reservations').update({status: 'cancelled'}).eq('id', resId);
    await db.from('slots').update({is_booked: false}).eq('id', slotId);
    
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
        alert(`Auto-promoted team ${w.team.display_name} from waiting list!`);
    }
    
    loadProfSlots();
    loadWaiting();
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
                    <strong>${r.team.display_name}</strong> wants ${fmtDate(r.slot.slot_date)} ${fmtTime(r.slot.start_time)}
                </div>
                <button onclick="approveReservation('${r.id}')" class="btn btn-sm btn-success">Approve</button>
            </div>
        `;
    });
}

async function approveReservation(resId) {
    const {data: res} = await db.from('reservations').select('*, slot:slots(*)').eq('id', resId).single();
    await db.from('reservations').update({status: 'confirmed', is_duplicate: false}).eq('id', resId);
    await db.from('slots').update({is_booked: true}).eq('id', res.slot.id);
    alert('Approved!');
    loadPending();
    loadProfSlots();
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
                <strong>${w.team.display_name}</strong> waiting for ${fmtDate(w.slot.slot_date)} ${fmtTime(w.slot.start_time)}
                <span class="badge bg-secondary float-end">${new Date(w.requested_at).toLocaleTimeString()}</span>
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
        const [sec, team, email] = line.split(',').map(s => s.trim());
        if (sec && team) teams.push({section_number: parseInt(sec), team_number: parseInt(team), email: email || null});
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
    
    if (!name || !email || !pin) {
        alert('Please fill in all fields');
        return;
    }
    
    try {
        const {error} = await db.from('professors').insert({name, email, pin});
        if (error) {
            alert('Database error: ' + error.message);
            console.error(error);
            return;
        }
        alert('Professor added successfully!');
        document.getElementById('newProfName').value = '';
        document.getElementById('newProfEmail').value = '';
        document.getElementById('newProfPin').value = '';
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
});