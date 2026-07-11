const videoElement = document.querySelector('.input_video');
const canvasElement = document.querySelector('.output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const webglCanvas = document.querySelector('.webgl_canvas');
const loadingOverlay = document.getElementById('loading');
const colorBtns = document.querySelectorAll('.color-btn');
const clearBtn = document.getElementById('clearBtn');

// ===================== STATE =====================
let currentColor = '#ff33aa';
let lastPlacedVoxelPos = null;
let currentGestureState = 'NONE';
let gestureHistory = [];
const HISTORY_LENGTH = 5;

let isDragging = false;
let dragPlaneLocal = new THREE.Plane();
let dragNormalLocal = new THREE.Vector3();
let isWorld3D = false;


let zoomInitialized = false;
let initialZoomDist = 0;
let initialCameraZoom = 1;

let isTranslating = false;
let startHandPos = new THREE.Vector2();
let startWorldPos = new THREE.Vector3();

let isRotating = false;
let startAvgHandPos = new THREE.Vector2();
let startWorldRot = new THREE.Vector3();

let confirmedHandedness = null;
let pendingHandedness = null;

// ===================== AUDIO =====================
const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContext();

function playBlockSound(frequency) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(frequency * 0.8, audioCtx.currentTime + 0.1);
    gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
}

function playExplosionSound() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const bufferSize = audioCtx.sampleRate * 1.5;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const noiseSource = audioCtx.createBufferSource();
    noiseSource.buffer = buffer;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, audioCtx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(10, audioCtx.currentTime + 1.0);
    const gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(0.8, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 1.0);
    noiseSource.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    noiseSource.start();
}

// ===================== THREE.JS SETUP =====================
const scene = new THREE.Scene();
const camera3D = new THREE.OrthographicCamera(-1280 / 2, 1280 / 2, 720 / 2, -720 / 2, -5000, 5000);
camera3D.position.set(0, 0, 1500);
camera3D.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(1280, 720, false);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.position.set(500, 800, 500);
scene.add(directionalLight);

// Voxel settings
const VOXEL_SIZE = 50;
const voxelGeo = new THREE.BoxGeometry(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE);

// Group that holds the grid and all voxels
const worldGroup = new THREE.Group();
scene.add(worldGroup);

// Invisible plane for raycasting
const planeGeo = new THREE.PlaneGeometry(50000, 50000);
const invisiblePlane = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ visible: false }));
worldGroup.add(invisiblePlane);

// Roll-over cursor (wireframe box)
const rollOverEdges = new THREE.EdgesGeometry(voxelGeo);
const rollOverMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, linewidth: 2 });
const rollOverMesh = new THREE.LineSegments(rollOverEdges, rollOverMaterial);
rollOverMesh.visible = false;
worldGroup.add(rollOverMesh);

const objects = [invisiblePlane];
const raycaster = new THREE.Raycaster();
const mouse3D = new THREE.Vector2();

// Explosion particles
const explosionParticles = [];

// Glow particles per voxel
const glowEntries = [];

// ===================== ANIMATE LOOP =====================
function animate3D() {
    requestAnimationFrame(animate3D);
    rollOverMaterial.color.setHex(parseInt(currentColor.replace('#', '0x')));

    for (let i = explosionParticles.length - 1; i >= 0; i--) {
        const p = explosionParticles[i];
        p.position.add(p.userData.velocity);
        p.userData.velocity.y -= 0.5;
        p.rotation.x += p.userData.rotSpeed.x;
        p.rotation.y += p.userData.rotSpeed.y;
        p.userData.life -= 0.015;

        if (p.userData.life <= 0 || p.position.y < -2000) {
            scene.remove(p);
            if (p.geometry) p.geometry.dispose();
            if (p.material) p.material.dispose();
            explosionParticles.splice(i, 1);
        }
    }

    const time = Date.now() * 0.003;
    const isRainbowMode = (currentGestureState === 'STOP');

    for (const entry of glowEntries) {
        const positions = entry.points.geometry.attributes.position.array;
        const originals = entry.originalPositions;
        for (let i = 0; i < positions.length; i += 3) {
            positions[i]     = originals[i]     + Math.sin(time + i * 0.5) * 2;
            positions[i + 1] = originals[i + 1] + Math.cos(time + i * 0.7) * 2;
            positions[i + 2] = originals[i + 2] + Math.sin(time + i * 1.1) * 2;
        }
        entry.points.geometry.attributes.position.needsUpdate = true;

        if (isRainbowMode) {
            if (entry.originalColor === undefined) {
                entry.originalColor = entry.parentGroup.children[0].material.color.getHex();
                entry.hueOffset = Math.random();
            }
            // Generate bright random rainbow color that cycles rapidly
            const hue = ((Date.now() * 0.002) + entry.hueOffset) % 1.0;
            const rainbowColor = new THREE.Color().setHSL(hue, 1.0, 0.6);

            entry.parentGroup.children[0].material.color.copy(rainbowColor);
            entry.parentGroup.children[1].material.color.copy(rainbowColor);
            entry.points.material.color.copy(rainbowColor);
            
            // Randomly flash opacity for extra "bersinar" effect
            entry.parentGroup.children[1].material.opacity = (Math.random() * 0.4) + (isWorld3D ? 0.4 : 0.2);
        } else if (entry.originalColor !== undefined) {
            const orig = new THREE.Color(entry.originalColor);
            entry.parentGroup.children[0].material.color.copy(orig);
            entry.parentGroup.children[1].material.color.copy(orig);
            entry.points.material.color.copy(orig);
            entry.parentGroup.children[1].material.opacity = isWorld3D ? 0.6 : 0.4;
            delete entry.originalColor;
            delete entry.hueOffset;
        }
    }

    renderer.render(scene, camera3D);
}
animate3D();

// ===================== UI INTERACTIONS =====================
colorBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        colorBtns.forEach(b => { b.classList.remove('active'); b.style.boxShadow = 'none'; });
        btn.classList.add('active');
        currentColor = btn.dataset.color;
        btn.style.boxShadow = `0 0 15px ${currentColor}`;
    });
});

// ===================== EXPLOSION =====================
function triggerExplosion() {
    const voxelGroups = [];
    for (let i = worldGroup.children.length - 1; i >= 0; i--) {
        const obj = worldGroup.children[i];
        if (obj.type === 'Group') {
            voxelGroups.push(obj);
        }
    }
    // Reset kamera dan dunia kembali ke 2D rata
    worldGroup.rotation.set(0, 0, 0);
    worldGroup.position.set(0, 0, 0);
    camera3D.zoom = 1;
    camera3D.updateProjectionMatrix();
    isWorld3D = false;

    if (voxelGroups.length === 0) return;

    playExplosionSound();

    voxelGroups.forEach(group => {
        const worldPos = new THREE.Vector3();
        group.getWorldPosition(worldPos);

        let voxelColor = 0xff33aa;
        if (group.children.length > 0 && group.children[0].material) {
            voxelColor = group.children[0].material.color.getHex();
        }

        for (let i = 0; i < 12; i++) {
            const pGeom = new THREE.BoxGeometry(12, 12, 12);
            const pMat = new THREE.MeshLambertMaterial({ color: voxelColor });
            const p = new THREE.Mesh(pGeom, pMat);

            p.position.copy(worldPos);
            p.position.x += (Math.random() - 0.5) * VOXEL_SIZE;
            p.position.y += (Math.random() - 0.5) * VOXEL_SIZE;
            p.position.z += (Math.random() - 0.5) * VOXEL_SIZE;

            p.userData = {
                velocity: new THREE.Vector3((Math.random() - 0.5) * 30, Math.random() * 25 + 10, (Math.random() - 0.5) * 30),
                rotSpeed: new THREE.Vector3(Math.random() * 0.2, Math.random() * 0.2, Math.random() * 0.2),
                life: 1.0
            };
            scene.add(p);
            explosionParticles.push(p);
        }

        group.children.forEach(child => {
            const idx = objects.indexOf(child);
            if (idx > -1) objects.splice(idx, 1);
        });

        for (let j = glowEntries.length - 1; j >= 0; j--) {
            if (glowEntries[j].parentGroup === group) {
                worldGroup.remove(glowEntries[j].points);
                glowEntries[j].points.geometry.dispose();
                glowEntries[j].points.material.dispose();
                glowEntries.splice(j, 1);
            }
        }

        worldGroup.remove(group);
        group.children.forEach(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    });
}
clearBtn.addEventListener('click', triggerExplosion);

// ===================== MEDIAPIPE HANDS =====================
const hands = new Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`});
hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.7, minTrackingConfidence: 0.7 });
hands.onResults(onResults);

const camera = new Camera(videoElement, {
    onFrame: async () => { await hands.send({ image: videoElement }); },
    width: 1280, height: 720
});
camera.start().catch(err => alert("Error accessing camera: " + err));

// Use 2D distance with aspect ratio correction (1280x720 = 1.777) to eliminate noisy Z-axis issues
function getDistance(p1, p2) {
    const dx = (p1.x - p2.x) * 1.777;
    const dy = p1.y - p2.y;
    return Math.hypot(dx, dy);
}

function isFingerOpen(landmarks, tipIdx, pipIdx) {
    const wrist = landmarks[0];
    // Compare 2D tip distance to wrist vs pip distance to wrist
    return getDistance(landmarks[tipIdx], wrist) > getDistance(landmarks[pipIdx], wrist);
}

function analyzeHand(landmarks) {
    const wrist = landmarks[0];
    const thumbTip = landmarks[4], indexTip = landmarks[8], middleTip = landmarks[12], ringTip = landmarks[16], pinkyTip = landmarks[20];
    
    // Scale-invariant reference size (Wrist to Middle Knuckle)
    const palmSize = getDistance(wrist, landmarks[9]);
    
    const idxOpen = isFingerOpen(landmarks, 8, 6);
    const midOpen = isFingerOpen(landmarks, 12, 10);
    const ringOpen = isFingerOpen(landmarks, 16, 14);
    const pinkyOpen = isFingerOpen(landmarks, 20, 18);
    
    // Pinch detection (relative to palm size)
    const pinchDist = getDistance(thumbTip, indexTip);
    const pinchRatio = pinchDist / (palmSize || 1);
    const pinchThresh = (currentGestureState === 'PINCH') ? 0.6 : 0.25; // Tightened to 0.25 so fists don't trigger pinch
    const isPinch = pinchRatio < pinchThresh;
    
    // Fist detection - strictly all 4 fingers closed
    const isFist = !idxOpen && !midOpen && !ringOpen && !pinkyOpen;
    
    // Thumbs Up detection
    const thumbToIndexMcp = getDistance(thumbTip, landmarks[5]);
    const thumbExtended = thumbToIndexMcp / (palmSize || 1) > 0.5; // Relaxed from 0.8 so lazy thumbs up don't register as fist
    const isThumbsUp = isFist && thumbExtended;
    
    const isHover = idxOpen && !midOpen && !ringOpen && !pinkyOpen && !isPinch;
    const isTwoFingers = idxOpen && midOpen && !ringOpen && !pinkyOpen && !isPinch;
    const isAllOpen = idxOpen && midOpen && ringOpen && pinkyOpen && !isFist;
    
    return {
        isFist: isFist && !isThumbsUp,
        isThumbsUp,
        isTwoFingers,
        isAllOpen,
        isPinch,
        isHover,
        wrist,
        indexTip,
        thumbTip
    };
}

// ===================== EXPORT TO PDF =====================
let isExportingPDF = false;
async function exportToPDF() {
    if (isExportingPDF) return;
    isExportingPDF = true;
    
    const pdfLoading = document.getElementById('pdf-loading');
    pdfLoading.style.display = 'flex';
    pdfLoading.style.opacity = '1';

    // Wait a bit for UI to update
    await new Promise(r => setTimeout(r, 100));

    try {
        const mergedCanvas = document.createElement('canvas');
        mergedCanvas.width = canvasElement.width;
        mergedCanvas.height = canvasElement.height;
        const ctx = mergedCanvas.getContext('2d');
        
        // Fill white background like a paper
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, mergedCanvas.width, mergedCanvas.height);
        
        // Force render of 3D scene
        renderer.render(scene, camera3D);
        
        // Draw 3D blocks over white background
        ctx.drawImage(webglCanvas, 0, 0);
        
        const dataUrl = mergedCanvas.toDataURL('image/jpeg', 0.9);
        
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({
            orientation: 'landscape',
            unit: 'px',
            format: [mergedCanvas.width, mergedCanvas.height]
        });
        
        pdf.addImage(dataUrl, 'JPEG', 0, 0, mergedCanvas.width, mergedCanvas.height);
        pdf.save('VoxelBuilder_Export.pdf');
    } catch(e) {
        console.error("PDF Export failed: ", e);
    }

    pdfLoading.style.opacity = '0';
    setTimeout(() => {
        pdfLoading.style.display = 'none';
        isExportingPDF = false;
    }, 500);
}

// ===================== GESTURE DEBOUNCING =====================
function transitionGesture(rawGesture, activeHandedness) {
    gestureHistory.push({ gesture: rawGesture, handedness: activeHandedness });
    if (gestureHistory.length > HISTORY_LENGTH) {
        gestureHistory.shift();
    }

    const counts = {};
    let maxCount = 0;
    let mostFrequent = 'NONE';
    let mostFrequentHandedness = null;
    
    for (const item of gestureHistory) {
        const g = item.gesture;
        counts[g] = (counts[g] || 0) + 1;
        if (counts[g] > maxCount) {
            maxCount = counts[g];
            mostFrequent = g;
            mostFrequentHandedness = item.handedness;
        }
    }

    let requiredCount = 3;
    if (mostFrequent === 'DESTROY') requiredCount = 4;

    let newState = currentGestureState;
    if (maxCount >= requiredCount) {
        newState = mostFrequent;
    }

    if (newState !== currentGestureState) {
        const oldState = currentGestureState;
        currentGestureState = newState;

        if (['PINCH', 'HOVER', 'MOVE_WORLD', 'DESTROY', 'STOP', 'THUMBS_UP'].includes(currentGestureState)) {
            confirmedHandedness = mostFrequentHandedness;
        } else {
            confirmedHandedness = null;
        }

        if (currentGestureState === 'DESTROY') triggerExplosion();
        if (currentGestureState === 'THUMBS_UP') exportToPDF();
        
        // Clean up states when leaving
        if (oldState === 'PINCH') { lastPlacedVoxelPos = null; isDragging = false; }
        if (oldState === 'MOVE_WORLD') isTranslating = false;
        if (oldState === 'ROTATING') isRotating = false;
        if (oldState === 'ZOOM') zoomInitialized = false;
    }
}

function getSingleGesture(hand) {
    if (hand.isPinch) return 'PINCH';
    if (hand.isThumbsUp) return 'THUMBS_UP';
    if (hand.isFist) return 'DESTROY'; 
    if (hand.isHover) return 'HOVER';
    if (hand.isTwoFingers) return 'STOP';
    if (hand.isAllOpen) return 'MOVE_WORLD';
    return 'NONE';
}

function onResults(results) {
    if (loadingOverlay.style.display !== 'none') {
        loadingOverlay.style.opacity = '0';
        setTimeout(() => loadingOverlay.style.display = 'none', 500);
    }
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        for (const landmarks of results.multiHandLandmarks) {
            drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, { color: currentColor, lineWidth: 2 });
            drawLandmarks(canvasCtx, landmarks, { color: '#ffffff', lineWidth: 1, radius: 3 });
        }
    }
    // Always process gestures so debouncing handles 1-frame drops smoothly
    processVoxelGestures(results);
    canvasCtx.restore();
}

// ===================== MAIN PROCESSOR =====================
function processVoxelGestures(results) {
    const multiHandLandmarks = results.multiHandLandmarks || [];
    const multiHandedness = results.multiHandedness || [];
    let rawGesture = 'NONE', activeHandedness = null;

    if (multiHandLandmarks.length === 2) {
        const hand1 = analyzeHand(multiHandLandmarks[0]), hand2 = analyzeHand(multiHandLandmarks[1]);
        const isRot1 = hand1.isAllOpen || hand1.isTwoFingers;
        const isRot2 = hand2.isAllOpen || hand2.isTwoFingers;
        
        if (hand1.isPinch && hand2.isPinch) rawGesture = 'ZOOM';
        else if (isRot1 && isRot2) rawGesture = 'ROTATING';
        else {
            const g1 = getSingleGesture(hand1), g2 = getSingleGesture(hand2);
            const pri = { 'PINCH': 4, 'HOVER': 3, 'STOP': 2, 'DESTROY': 1, 'MOVE_WORLD': 0, 'NONE': -1 };
            if (pri[g1] >= pri[g2]) { rawGesture = g1; activeHandedness = multiHandedness[0]?.label || 'Right'; }
            else { rawGesture = g2; activeHandedness = multiHandedness[1]?.label || 'Left'; }
        }
    } else if (multiHandLandmarks.length === 1) {
        activeHandedness = multiHandedness[0]?.label || 'Right';
        rawGesture = getSingleGesture(analyzeHand(multiHandLandmarks[0]));
    }

    transitionGesture(rawGesture, activeHandedness);
    const state = currentGestureState;
    let execHand = null, execWrist1 = null, execWrist2 = null;

    if (multiHandLandmarks.length === 2) {
        if (state === 'ZOOM' || state === 'ROTATING') { execWrist1 = multiHandLandmarks[0][0]; execWrist2 = multiHandLandmarks[1][0]; }
        else {
            const h1 = analyzeHand(multiHandLandmarks[0]);
            const h2 = analyzeHand(multiHandLandmarks[1]);
            if (getSingleGesture(h1) === state) execHand = h1;
            else if (getSingleGesture(h2) === state) execHand = h2;
            else {
                const idx = multiHandedness.findIndex(h => h && h.label === confirmedHandedness);
                if (idx !== -1) execHand = analyzeHand(multiHandLandmarks[idx]);
            }
        }
    } else if (multiHandLandmarks.length === 1) {
        execHand = analyzeHand(multiHandLandmarks[0]);
    }

    if (execHand && (state === 'PINCH' || state === 'HOVER') && rawGesture !== 'ZOOM') {
        mouse3D.set(((1 - execHand.indexTip.x) * 2) - 1, -(execHand.indexTip.y * 2) + 1);
        raycaster.setFromCamera(mouse3D, camera3D);
        if (state === 'PINCH') {
            if (!isDragging) {
                if (window.lastHoverAim) {
                    // Lock the first block creation to exactly where they were aiming
                    dragNormalLocal.copy(window.lastHoverAim.normal);
                    dragPlaneLocal.setFromNormalAndCoplanarPoint(dragNormalLocal, window.lastHoverAim.localPoint.clone().add(window.lastHoverAim.normal));
                    isDragging = true;
                } else {
                    const intersects = raycaster.intersectObjects(objects, false);
                    if (intersects.length > 0) {
                        const intersect = intersects[0];
                        const localPoint = worldGroup.worldToLocal(intersect.point.clone());
                        dragNormalLocal.copy(intersect.face.normal);
                        dragPlaneLocal.setFromNormalAndCoplanarPoint(dragNormalLocal, localPoint.clone().add(intersect.face.normal));
                        isDragging = true;
                    }
                }
            }
            if (isDragging) {
                const localRay = new THREE.Ray().copy(raycaster.ray).applyMatrix4(worldGroup.matrixWorld.clone().invert());
                const localTarget = new THREE.Vector3();
                if (localRay.intersectPlane(dragPlaneLocal, localTarget)) {
                    rollOverMesh.position.copy(localTarget).add(dragNormalLocal.clone().multiplyScalar(0.1)).divideScalar(VOXEL_SIZE).floor().multiplyScalar(VOXEL_SIZE).addScalar(VOXEL_SIZE / 2);
                    rollOverMesh.visible = true;
                    const posKey = `${rollOverMesh.position.x},${rollOverMesh.position.y},${rollOverMesh.position.z}`;
                    if (posKey !== lastPlacedVoxelPos) { createVoxel(rollOverMesh.position, currentColor); lastPlacedVoxelPos = posKey; }
                }
            }
        } else {
            // state === 'HOVER'
            const intersects = raycaster.intersectObjects(objects, false);
            if (intersects.length > 0) {
                const intersect = intersects[0];
                rollOverMesh.position.copy(worldGroup.worldToLocal(intersect.point.clone())).add(intersect.face.normal).divideScalar(VOXEL_SIZE).floor().multiplyScalar(VOXEL_SIZE).addScalar(VOXEL_SIZE / 2);
                if (intersect.object === invisiblePlane) rollOverMesh.position.z = VOXEL_SIZE / 2;
                rollOverMesh.visible = true;
                
                // Save this aim so when they pinch, it starts exactly here!
                window.lastHoverAim = {
                    localPoint: worldGroup.worldToLocal(intersect.point.clone()),
                    normal: intersect.face.normal.clone()
                };
            } else {
                rollOverMesh.visible = false;
                window.lastHoverAim = null;
            }
        }
    } else {
        rollOverMesh.visible = false;
        window.lastHoverAim = null;
    }

    // ---- MOVE WORLD (1 Open Hand) ----
    if (state === 'MOVE_WORLD' && execHand && multiHandLandmarks.length === 1) {
        const cx = 1 - execHand.wrist.x;
        const cy = execHand.wrist.y;
        
        if (!isTranslating) {
            isTranslating = true;
            startHandPos.set(cx, cy);
            startWorldPos.copy(worldGroup.position);
        } else {
            const dx = (cx - startHandPos.x) * 2000; 
            const dy = -(cy - startHandPos.y) * 2000;
            worldGroup.position.x += ((startWorldPos.x + dx) - worldGroup.position.x) * 0.2;
            worldGroup.position.y += ((startWorldPos.y + dy) - worldGroup.position.y) * 0.2;
        }
    } else {
        isTranslating = false;
    }

    // ---- ROTATING WORLD (2 Open Hands) ----
    if (state === 'ROTATING' && execWrist1 && execWrist2 && multiHandLandmarks.length === 2) {
        const cx1 = 1 - execWrist1.x, cy1 = execWrist1.y;
        const cx2 = 1 - execWrist2.x, cy2 = execWrist2.y;
        const avgCx = (cx1 + cx2) / 2;
        const avgCy = (cy1 + cy2) / 2;
        
        if (!isRotating) {
            isRotating = true;
            startAvgHandPos.set(avgCx, avgCy);
            startWorldRot.set(worldGroup.rotation.x, worldGroup.rotation.y, 0);
        } else {
            const dx = (avgCx - startAvgHandPos.x) * Math.PI * 1.5; 
            const dy = (avgCy - startAvgHandPos.y) * Math.PI * 1.5;
            const targetRotY = startWorldRot.y + dx;
            const targetRotX = startWorldRot.x + dy;
            
            worldGroup.rotation.y += (targetRotY - worldGroup.rotation.y) * 0.2;
            worldGroup.rotation.x += (targetRotX - worldGroup.rotation.x) * 0.2;

            // Update voxel 3D visuals based on rotation
            const isCurrently3D = Math.abs(worldGroup.rotation.x % (Math.PI*2)) > 0.1 || Math.abs(worldGroup.rotation.y % (Math.PI*2)) > 0.1;
            if (isWorld3D !== isCurrently3D) {
                isWorld3D = isCurrently3D;
                objects.forEach(obj => {
                    if (obj.material && obj.geometry.type !== 'PlaneGeometry') {
                        obj.material.opacity = isWorld3D ? 0.6 : 0.4;
                        obj.material.transparent = true;
                        obj.material.needsUpdate = true;
                    }
                });
            }
        }
    } else {
        isRotating = false;
    }

    // ---- ZOOMING WORLD (2 Pinching Hands) ----
    if (state === 'ZOOM' && execWrist1 && execWrist2 && multiHandLandmarks.length === 2) {
        const dist = Math.hypot(execWrist1.x - execWrist2.x, execWrist1.y - execWrist2.y);

        if (!zoomInitialized) {
            initialZoomDist = dist;
            initialCameraZoom = camera3D.zoom;
            zoomInitialized = true;
        } else if (initialZoomDist > 0.01) {
            const targetZoom = initialCameraZoom * (dist / initialZoomDist);
            const clampedZoom = Math.max(0.2, Math.min(targetZoom, 5.0));
            camera3D.zoom += (clampedZoom - camera3D.zoom) * 0.15;
            camera3D.updateProjectionMatrix();
        }
    } else {
        zoomInitialized = false;
    }
}

// ===================== CREATE VOXEL =====================
function createVoxel(position, colorHex) {
    const colorValue = parseInt(colorHex.replace('#', '0x'));
    const voxelGroup = new THREE.Group();

    // Wireframe edges (bright, colored glow)
    const edgesGeo = new THREE.EdgesGeometry(voxelGeo);
    const lineMat = new THREE.LineBasicMaterial({ color: colorValue, linewidth: 2 });
    const edgeMesh = new THREE.LineSegments(edgesGeo, lineMat);
    edgeMesh.position.copy(position);
    voxelGroup.add(edgeMesh);

    // Semi-transparent fill initially (85% opaque if in 3D mode)
    const fillMat = new THREE.MeshLambertMaterial({
        color: colorValue,
        transparent: true,
        opacity: isWorld3D ? 0.6 : 0.4
    });
    const fillMesh = new THREE.Mesh(voxelGeo, fillMat);
    fillMesh.position.copy(position);
    voxelGroup.add(fillMesh);

    // Glowing particle sparkles along edges
    const edgePositions = edgesGeo.attributes.position.array;
    const sparkleCount = 24;
    const sparklePositions = new Float32Array(sparkleCount * 3);
    for (let i = 0; i < sparkleCount; i++) {
        const vi = Math.floor(Math.random() * (edgePositions.length / 3)) * 3;
        sparklePositions[i * 3]     = edgePositions[vi]     + position.x + (Math.random() - 0.5) * 4;
        sparklePositions[i * 3 + 1] = edgePositions[vi + 1] + position.y + (Math.random() - 0.5) * 4;
        sparklePositions[i * 3 + 2] = edgePositions[vi + 2] + position.z + (Math.random() - 0.5) * 4;
    }
    const sparkleGeo = new THREE.BufferGeometry();
    sparkleGeo.setAttribute('position', new THREE.BufferAttribute(sparklePositions, 3));
    const sparkleMat = new THREE.PointsMaterial({
        color: colorValue,
        size: 3,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const sparklePoints = new THREE.Points(sparkleGeo, sparkleMat);
    worldGroup.add(sparklePoints);

    // Store ORIGINAL positions for oscillation (so particles don't drift away)
    const originalPositions = new Float32Array(sparklePositions);
    glowEntries.push({
        points: sparklePoints,
        originalPositions: originalPositions,
        parentGroup: voxelGroup
    });

    worldGroup.add(voxelGroup);
    objects.push(fillMesh);

    playBlockSound(600 + Math.random() * 200);
}
