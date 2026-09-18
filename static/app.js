/* 所有推荐由 Python 返回；浏览器只负责输入、策略切换和地图展示。 */
const $ = (selector) => document.querySelector(selector);
const colors = ["#007aff", "#af52de", "#ff9500", "#30b59a", "#ff6482", "#7377d8"];
// 头像只保存在当前页面，不作为地点或路线查询参数发送。
const avatars = [
  {id:"cat",name:"小猫"}, {id:"dog",name:"小狗"}, {id:"fox",name:"狐狸"},
  {id:"panda",name:"熊猫"}, {id:"rabbit",name:"兔子"}, {id:"bear",name:"小熊"},
];
const avatarFor = (p) => avatars.find((a)=>a.id===p.avatarId) || avatars[0];
const avatarSource = (avatar) => `/static/avatars/${avatar.id}.png`;
function avatarImage(p) {
  return `<img class="animal-avatar" data-avatar-person="${p.id}" src="${avatarSource(avatarFor(p))}" alt="" width="44" height="44" draggable="false">`;
}

function openAvatarPicker(p) {
  if(state.busy) return;
  $("#avatar-dialog-title").textContent=`为${p.name || "朋友"}选个头像`;
  $("#avatar-options").innerHTML=avatars.map((a)=>`<button type="button" class="avatar-option" data-avatar="${a.id}" aria-pressed="${p.avatarId===a.id}"><img src="${avatarSource(a)}" alt="" width="72" height="72"><span>${a.name}</span><i aria-hidden="true">✓</i></button>`).join("");
  $("#avatar-options").querySelectorAll("[data-avatar]").forEach((button)=>button.addEventListener("click",()=>{
    const avatar=avatars.find((a)=>a.id===button.dataset.avatar);
    if(!avatar || !state.people.includes(p)) return;
    p.avatarId=avatar.id;
    // 只更新现有图片，保留地点搜索结果、输入焦点和已绘制的地图。
    document.querySelectorAll(`[data-avatar-person="${p.id}"]`).forEach((img)=>{img.src=avatarSource(avatar);});
    const trigger=document.querySelector(`.person-card[data-person="${p.id}"] .avatar-button`);
    if(trigger) trigger.setAttribute("aria-label",`更换${p.name}的头像，当前：${avatar.name}`);
    $("#avatar-dialog").close();
  }));
  $("#avatar-dialog").showModal();
  $("#avatar-options").querySelector('[aria-pressed="true"]')?.focus();
}
const state = {strategy:"balanced", people:[], result:null, selected:null,
  config:null, busy:false, map:null, sequence:0, nextId:0, mapPromise:null,
  locating:false, locationVersion:0, mapVersion:0, routePage:0};
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]));
const colorFor = (index) => colors[index % colors.length];

async function api(path, options={}) {
  let response;
  try { response = await fetch(path, {headers:{"Content-Type":"application/json"}, ...options}); }
  catch { throw new Error("无法连接本地服务，请确认服务已启动后刷新页面。"); }
  let data;
  try { data = await response.json(); } catch { throw new Error("服务返回异常，请确认本地服务仍在运行。"); }
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "请求未完成，请检查输入后重试。");
  return data;
}

function showError(message="") {
  $("#error").textContent = message;
  $("#error").hidden = !message;
}

function person(name, origin=null, max=60) {
  const avatar=avatars.find((a)=>!state.people.some((p)=>p.avatarId===a.id)) || avatars[state.nextId%avatars.length];
  return {id:++state.nextId, name, origin, avatarId:avatar.id, query:origin?.name || "", max_minutes:max, searchVersion:0, searching:false};
}

function nextFriendName() {
  // 按现有称呼寻找空闲编号，删除参与者后不再用人数推算名称。
  // 默认“朋友”占用编号 1，同时兼容手动输入的“朋友2”“朋友 2”。
  const used=new Set(state.people.map((p)=>p.name.replace(/\s+/g,"")));
  if(used.has("朋友")) used.add("朋友1");
  let number=1;
  while(used.has(`朋友${number}`)) number++;
  return `朋友 ${number}`;
}

function invalidate() {
  state.sequence++;
  state.result = null;
  state.selected = null;
  showError();
  renderResults();
  setBusy(state.busy);
}

// 参与者全部平铺展示；校验失败时只需切回出发信息区域。
function showPerson() {
  setMobileView('planning');
}
function setMobileView(view) {
  $('.workspace').dataset.mobileView=view;
  document.querySelectorAll('[data-view]').forEach((button)=>button.setAttribute('aria-pressed',String(button.dataset.view===view)));
  // 地图从隐藏状态恢复后通知其重新计算容器尺寸。
  if(view==='map' && state.map) requestAnimationFrame(()=>state.map?.checkResize?.());
}
// 没有推荐地点时隐藏结果页签；清空结果后避免停留在空白详情页。
function syncResultNavigation(hasResults) {
  document.querySelectorAll('[data-view="places"], [data-view="details"]').forEach((button)=>{button.hidden=!hasResults;});
  if(!hasResults && ['places','details'].includes($('.workspace').dataset.mobileView)) setMobileView('map');
}
function syncRoutePage() {
  const size=window.innerWidth<=760 && window.innerHeight<780 ? 1 : 2;
  const cards=[...document.querySelectorAll('.route-card')], pages=Math.ceil(cards.length/size);
  state.routePage=Math.max(0,Math.min(state.routePage,pages-1));
  cards.forEach((card,i)=>{card.hidden=Math.floor(i/size)!==state.routePage;});
  const controls=$('#route-pages');
  if(!controls) return;
  controls.hidden=pages<=1;
  $('#route-page-label').textContent=`路程 ${state.routePage+1} / ${pages}`;
  $('#route-prev').disabled=state.routePage===0;
  $('#route-next').disabled=state.routePage===pages-1;
}

function renderPeople() {
  $("#person-count").textContent = `${state.people.length} / 6 人`;
  $("#sheet-summary").textContent = `${state.people.length} 人同行`;
  $("#add-person").disabled = state.people.length >= 6;
  $("#participants").innerHTML = state.people.map((p, index) => `
    <article class="person-card" data-person="${p.id}" style="--person-color:${colorFor(index)}">
      <div class="person-top"><button type="button" class="avatar-button" aria-label="更换${escapeHtml(p.name)}的头像，当前：${avatarFor(p).name}" aria-haspopup="dialog">${avatarImage(p)}<span class="avatar-edit" aria-hidden="true">⌄</span></button>
        <input class="person-name" aria-label="第 ${index+1} 位参与者称呼" maxlength="20" required value="${escapeHtml(p.name)}">
        <button type="button" class="remove-person" aria-label="移除第 ${index+1} 位参与者" ${state.people.length<=2?"disabled":""}>×</button>
      </div>
      <label class="origin-label" for="origin-${p.id}">从哪里出发</label>
      <div class="origin-row"><input class="origin-input" id="origin-${p.id}" placeholder="出发地点" value="${escapeHtml(p.query)}" maxlength="80" autocomplete="off">
        <button type="button" class="search-button" ${p.searching?"disabled":""}>查找</button></div>
      <ul class="suggestions" aria-label="出发地点搜索结果"></ul>
      <span class="search-status" role="status">${p.origin?escapeHtml(p.origin.address || "已选定出发地点"):""}</span>
      <label class="time-limit" for="limit-${p.id}">最多 <input id="limit-${p.id}" class="minutes-input" type="number" min="5" max="180" step="1" required value="${p.max_minutes}"> 分钟</label>
    </article>`).join("");
  document.querySelectorAll(".person-card").forEach((card) => {
    const p = state.people.find((item) => item.id === Number(card.dataset.person));
    card.querySelector(".avatar-button").addEventListener("click",()=>openAvatarPicker(p));
    card.querySelector(".person-name").addEventListener("input", (e) => {p.name=e.target.value; invalidate();});
    card.querySelector(".minutes-input").addEventListener("input", (e) => {p.max_minutes=Number(e.target.value); invalidate();});
    card.querySelector(".origin-input").addEventListener("input", (e) => {
      p.query=e.target.value; p.origin=null; p.searchVersion++;
      card.querySelector(".suggestions").replaceChildren();
      card.querySelector(".search-status").textContent="";
      invalidate();
    });
    card.querySelector(".remove-person").addEventListener("click", () => {
      state.people=state.people.filter((item) => item.id!==p.id); renderPeople(); invalidate();
    });
    card.querySelector(".search-button")?.addEventListener("click", () => searchOrigin(p, card));
    card.querySelector(".origin-input").addEventListener("keydown", (e) => {
      if(e.key==="Enter") {e.preventDefault(); searchOrigin(p,card);}
    });
  });
  $("#planning-panel").dataset.peopleCount=String(state.people.length);
}

async function searchOrigin(p, card) {
  // 使用参与者状态拦截连续回车和重绘后的重复点击，而不只依赖按钮禁用。
  if(state.busy || p.searching) return;
  const status = card.querySelector(".search-status");
  const list = card.querySelector(".suggestions");
  const button = card.querySelector(".search-button");
  const q = p.query.trim(), city = $("#city").value.trim();
  if(q.length<2 || city.length<2) {status.textContent="请填写城市和至少两个字的地点名称。"; return;}
  const version=++p.searchVersion;
  p.searching=true;
  button.disabled=true; status.textContent="正在查找地点…"; list.replaceChildren();
  try {
    const data = await api(`/api/places?${new URLSearchParams({q,city})}`);
    if(version!==p.searchVersion || !card.isConnected) return;
    status.textContent=data.places.length ? "请选择一个准确的出发地点。" : "未找到地点，请换一个名称。";
    for(const place of data.places) {
      const li=document.createElement("li"), choice=document.createElement("button");
      choice.type="button";
      choice.innerHTML=`${escapeHtml(place.name)}<small>${escapeHtml(place.address || place.city)}</small>`;
      choice.addEventListener("click", () => {
        p.searchVersion++;
        p.origin=place; p.query=place.name; card.querySelector(".origin-input").value=place.name;
        list.replaceChildren(); status.textContent="已选定出发地点"; invalidate();
      });
      li.append(choice); list.append(li);
    }
  } catch(error) {if(version===p.searchVersion && card.isConnected) status.textContent=error.message;}
  finally {
    p.searching=false; button.disabled=false;
    // 添加朋友或定位会重绘表单；请求结束后也要恢复新卡片上的按钮。
    const currentCard=document.querySelector(`.person-card[data-person="${p.id}"]`);
    if(currentCard) currentCard.querySelector(".search-button").disabled=false;
  }
}

function setBusy(busy) {
  state.busy=busy;
  $("#form-fields").disabled=busy;
  $("#locate-button").disabled=busy || state.locating || !state.config?.live_ready;
  $("#submit-button").disabled=busy || !state.config?.live_ready;
  $("#submit-button").innerHTML=busy?"正在计算大家的路程…":`${state.result?"重新计算":"找个地方碰头"} <svg class="icon" aria-hidden="true"><use href="#icon-arrow"/></svg>`;
  syncStrategies();
}

async function locateMe() {
  if(state.busy || state.locating || !state.config?.live_ready) return;
  const status=$("#location-status");
  if(!navigator.geolocation || !window.isSecureContext) {
    status.textContent="当前浏览器无法定位，请手动填写城市和出发地点。定位需要 HTTPS 或本机 localhost。";
    return;
  }
  const target=state.people[0], revision=target.searchVersion, city=$("#city").value;
  const version=++state.locationVersion;
  const stillCurrent=()=>version===state.locationVersion && state.people[0]===target &&
    target.searchVersion===revision && $("#city").value===city && !state.busy;
  state.locating=true; setBusy(false);
  status.textContent="正在请求定位，请在浏览器提示中允许访问位置；也可直接手动填写。";
  try {
    const position=await new Promise((resolve,reject)=>{
      // 外层计时也覆盖用户长时间未处理授权弹窗的情况。
      const timer=setTimeout(()=>reject({code:3}),20000);
      navigator.geolocation.getCurrentPosition(
        (value)=>{clearTimeout(timer);resolve(value);},
        (error)=>{clearTimeout(timer);reject(error);},
        {enableHighAccuracy:true, timeout:12000, maximumAge:60000});
    });
    if(!stillCurrent()) {status.textContent="你已修改出发信息，本次定位未覆盖手动输入。"; return;}
    status.textContent="已获取位置，正在识别所在城市…";
    const {place}=await api("/api/location",{method:"POST",body:JSON.stringify({
      lat:position.coords.latitude,lng:position.coords.longitude})});
    if(!stillCurrent()) {status.textContent="你已修改出发信息，本次定位未覆盖手动输入。"; return;}
    // 已选定朋友的城市时，不用一次重新定位悄悄清空其他人的信息。
    if(city.trim() && city.trim().replace(/市$/,"")!==place.city.replace(/市$/,"") &&
      state.people.slice(1).some((p)=>p.origin || p.query)) {
      status.textContent=`定位在${place.city}，与已填写的会合城市不同，请手动确认城市和出发地点。`;
      return;
    }
    $("#city").value=place.city;
    target.origin=place; target.query=place.name; target.searchVersion++;
    renderPeople(); invalidate();
    const accuracy=position.coords.accuracy;
    status.textContent=`已填写${place.city}和「${target.name}」的当前位置。${Number.isFinite(accuracy)?`定位精度约 ${Math.ceil(accuracy)} 米，请核对地址。`:"请核对地址。"}`;
  } catch(error) {
    const messages={1:"未获得定位授权，你可以手动填写城市和出发地点，或在浏览器设置中允许位置后重试。",
      2:"暂时无法获取位置，请手动填写，或稍后重新定位。",3:"定位超时，请手动填写，或点击定位按钮重试。"};
    status.textContent=messages[error.code] || error.message || "定位失败，请手动填写出发地点。";
  } finally {
    state.locating=false; setBusy(state.busy);
  }
}

function syncStrategies() {
  const noFeasible=state.result && !state.result.feasible_count;
  document.querySelectorAll("[data-strategy]").forEach((button)=>{
    button.disabled=state.busy || !state.result || Boolean(noFeasible);
    const active=button.dataset.strategy===state.strategy && !noFeasible;
    button.classList.toggle("active",active); button.setAttribute("aria-pressed",String(active));
  });

}

function arrivalTimes(candidate) {
  // 暂按全员同时出发：最后一个人抵达才能碰面，不能把个人路程相加。
  const seconds=candidate.routes.map((route)=>route.duration_seconds);
  return {first:Math.ceil(Math.min(...seconds)/60), meeting:Math.ceil(Math.max(...seconds)/60)};
}

function strategyComparison(data) {
  if(!data.feasible_count) return "";
  const balanced=data.candidates.find((c)=>c.uid===data.rankings.balanced[0]);
  const efficient=data.candidates.find((c)=>c.uid===data.rankings.efficient[0]);
  const same=balanced.uid===efficient.uid;
  return `<div class="strategy-summary"><strong>${same?"两种策略的首选是同一地点":"两种策略的首选不同"}</strong>
    <p>${same?"这个地点在本次可行候选中，同时拥有最短的最长耗时和最少的总耗时，切换后位置保持一致。":"切换策略会更新首选地点、候选排序和地图路线。"}</p>
    <div class="strategy-metrics">${[["最远的人也方便",balanced],["大家总耗时最少",efficient]].map(([label,c])=>
      `<div><span>${label}</span><strong>${escapeHtml(c.name)}</strong><small>预计碰面 ${arrivalTimes(c).meeting} 分钟后（同时出发） · 路程合计 ${c.total_minutes} 人分钟</small></div>`).join("")}</div></div>`;
}

async function submitMeeting(event) {
  event?.preventDefault();
  if(state.busy) return;
  showError();
  const invalid=$('#meeting-form').querySelector('input:invalid, select:invalid');
  if(invalid) {
    showPerson();
    invalid.reportValidity(); return;
  }
  const unnamed=state.people.findIndex((p)=>!p.name.trim());
  if(unnamed>=0) {showPerson();showError("请为每位参与者填写称呼。"); return;}
  const missing=state.people.find((p)=>!p.origin);
  if(missing) {showPerson(); showError(`请先查找并选定「${missing.name}」的出发地点。`); return;}
  const payload={city:$("#city").value.trim(),activity:$("#activity").value,
    participants:state.people.map((p)=>({name:p.name.trim(),origin:p.origin,max_minutes:p.max_minutes}))};
  const sequence=++state.sequence;
  state.result=null; state.selected=null;
  setBusy(true);
  syncResultNavigation(false);
  // 手机端提交后收起表单，直接呈现计算进度和结果。
  setSheetExpanded(false);
  setMobileView("map");
  $("#strategy-comparison").replaceChildren(); $("#result-updated").hidden=true;
  $("#result-count").textContent="";
  $("#result-area").innerHTML='<div class="empty-state"><div class="spinner" aria-hidden="true"></div><h3>把大家的路程放在一起</h3><p>正在比较候选地点和每个人的出行时间。<br>真实路线通常需要一些时间，请稍候。</p></div>';
  try {
    const data=await api("/api/recommend",{method:"POST",body:JSON.stringify(payload)});
    if(sequence!==state.sequence) return;
    state.result=data; state.selected=null; renderResults();
  } catch(error) {showError(error.message); renderResults();}
  finally {setBusy(false);}
}

function navigationUrl(origin, destination) {
  const params=new URLSearchParams({origin:`latlng:${origin.lat},${origin.lng}|name:${origin.name}`,
    destination:`latlng:${destination.lat},${destination.lng}|name:${destination.name}`,
    mode:"transit",region:state.result.city,coord_type:"bd09ll",output:"html",src:"webapp.penggetou.meeting"});
  return `https://api.map.baidu.com/direction?${params}`;
}

function renderResults() {
  const area=$("#result-area"), data=state.result;
  state.mapVersion++;
  syncResultNavigation(Boolean(data && (data.feasible_count ? data.rankings[state.strategy] : data.near_misses).length));
  syncStrategies();
  $("#strategy-comparison").innerHTML=data?strategyComparison(data):"";
  $("#result-updated").hidden=!data;
  if(data) $("#result-updated").textContent=`本次计算完成：${new Date(data.calculated_at).toLocaleTimeString("zh-CN")}。切换策略使用同一批数据；重新计算可能复用 3 分钟内的路线缓存。`;
  if(state.map) {state.map.clearOverlays(); state.map=null;}
  if(!data) {
    $("#result-count").textContent="";
    area.innerHTML=`<div class="result-layout result-layout-pending"><div class="map-empty"><div class="map-empty-tag"><svg class="icon" aria-hidden="true"><use href="#icon-pin"/></svg>等大家的出发地就位</div>
      <span class="map-decoration decoration-one" aria-hidden="true"><svg class="icon"><use href="#icon-location"/></svg></span>
      <span class="map-decoration decoration-two" aria-hidden="true"><svg class="icon"><use href="#icon-people"/></svg></span>
      <div class="welcome-card"><div class="welcome-icon"><svg class="icon" aria-hidden="true"><use href="#icon-people"/></svg></div>
      <h3>不同的起点，同一个期待。</h3><p>添加你和朋友的出发地，<br>找到一个对大家都方便的见面地点。</p>
      <div class="welcome-steps"><span>添加出发地</span><b>›</b><span>比较路程</span><b>›</b><span>一起碰头</span></div></div>
      <span class="map-placeholder-note">示意插画 · 查询后显示真实地图</span></div></div>`;
    return;
  }
  $("#result-count").textContent=`${data.evaluated_count} 个候选 · ${data.feasible_count} 个符合条件`;
  const feasible=data.feasible_count>0;
  const ids=feasible?data.rankings[state.strategy]:data.near_misses;
  if(!ids.length) {
    area.innerHTML=`<div class="empty-state"><span class="empty-symbol" aria-hidden="true">◎</span><h3>本次没有可推荐的地点</h3><p>${escapeHtml(data.warnings.join(" ") || "候选地点中没有全员可用的公交路线。可以调整出发地点或活动后重试。")}</p></div>`;
    return;
  }
  if(!ids.includes(state.selected)) state.selected=ids[0];
  const selected=data.candidates.find((item)=>item.uid===state.selected);
  const arrival=arrivalTimes(selected);
  const longest=Math.max(...selected.routes.map((route)=>route.minutes));
  const warning=!feasible?`<div class="limit-message"><strong>尚未满足所有人的时间上限</strong><p>请按下方路线中的耗时与超时提示调整限制，再重新计算。</p></div>`:"";
  const reason=feasible
    ? (state.strategy==="balanced" ? "按全员最长耗时从少到多排序；最长耗时相同时，再比较总耗时。" : "按全员总耗时从少到多排序；总耗时相同时，再比较最长耗时。")
    : "备选按最大超时量、总超时量依次排序。调整左侧限制并重新计算后，才会成为可行方案。";
  area.innerHTML=`<div class="result-layout"><div class="map-wrap" id="map-wrap"></div><article class="meeting-card">${warning}
    <div class="meeting-card-header"><div><span class="recommend-label ${feasible?"":"warning"}">${feasible?(state.selected===ids[0]?"本次候选中的首选":"另一个会合选择"):"需要放宽条件"}</span>
      <h3>${escapeHtml(selected.name)}</h3><p class="address">${escapeHtml(selected.address || "地址以地图信息为准")}</p></div>
      <div class="metrics"><div class="metric"><strong>${arrival.first}</strong><em>分钟后</em><span>最早到达</span></div><div class="metric"><strong>${arrival.meeting}</strong><em>分钟后</em><span>预计碰面 · 同时出发</span></div></div>
    </div>
    <div class="route-cards">${selected.routes.map((route,i)=>{
      const p=data.participants[i], over=route.duration_seconds>p.max_minutes*60;
      return `<div class="route-card" style="--person-color:${colorFor(i)}"><div class="route-card-top"><div class="person-label"><span class="route-avatar">${avatarImage(state.people[i])}</span><span>${escapeHtml(p.name)}</span></div><span class="route-minutes">${route.minutes}<small>分钟</small></span></div>
        <p class="route-description" title="${escapeHtml(route.summary)}">${escapeHtml(route.summary)}</p><div class="route-track"><i style="width:${Math.max(4,route.minutes/longest*100)}%"></i></div>
        <div class="route-status"><span class="${over?"over-limit":""}">${over?`超出上限 ${Math.ceil((route.duration_seconds-p.max_minutes*60)/60)} 分钟`:`在 ${p.max_minutes} 分钟上限内`}</span>
        <a href="${escapeHtml(navigationUrl(p.origin,selected))}" target="_blank" rel="noopener noreferrer">查看完整路线 ↗</a></div></div>`;
    }).join("")}</div><div class="details-footer"><div class="recommend-reason">${reason}</div><div class="page-controls" id="route-pages"><button type="button" id="route-prev" aria-label="上一组路线">‹</button><span id="route-page-label"></span><button type="button" id="route-next" aria-label="下一组路线">›</button></div></div>
    </article>
    <aside class="places-panel"><div class="places-heading"><h3>${feasible?"地点选择":"放宽条件备选"}</h3><span>${ids.length} 个地点 · 点击切换</span></div>
    <div class="alternatives">${ids.map((uid,index)=>{
      const item=data.candidates.find((c)=>c.uid===uid);
      const times=arrivalTimes(item);
      return `<button type="button" class="alternative ${uid===selected.uid?"selected":""}" data-candidate="${escapeHtml(uid)}" aria-pressed="${uid===selected.uid}"><span class="alternative-index">OPTION ${String(index+1).padStart(2,"0")}</span><h4>${escapeHtml(item.name)}</h4><div class="mini-stats"><div><strong>${times.first}</strong>分钟后<span>最早到达</span></div><div><strong>${times.meeting}</strong>分钟后<span>预计碰面</span></div></div></button>`;
    }).join("")}</div>
    <p class="warnings result-scope">${data.warnings.map(escapeHtml).join("<br>")}${data.warnings.length?"<br>":""}${escapeHtml(data.scope_note)} 耗时以查询时的估计为准，实际出行可能变化。</p></aside></div>`;
  syncRoutePage();
  $('#route-prev').addEventListener('click',()=>{state.routePage--;syncRoutePage();});
  $('#route-next').addEventListener('click',()=>{state.routePage++;syncRoutePage();});
  area.querySelectorAll("[data-candidate]").forEach((button)=>button.addEventListener("click",()=>{
    const scrollTop=$('.alternatives').scrollTop;
    state.selected=button.dataset.candidate; renderResults();
    $('.alternatives').scrollTop=scrollTop;
    setMobileView('details');
  }));
  renderMap(selected);
}

async function loadMap() {
  if(window.BMapGL) return;
  if(state.mapPromise) return state.mapPromise;
  if(!state.config.browser_ak) throw new Error("地图尚未配置，仍可在下方查看耗时并打开完整路线。");
  state.mapPromise=new Promise((resolve,reject)=>{
    const script=document.createElement("script");
    let settled=false;
    const finish=(error)=>{if(settled)return; settled=true; clearTimeout(timer); error?reject(error):resolve();};
    const timer=setTimeout(()=>finish(new Error("地图加载超时，可使用下方完整路线链接。")),18000);
    window.penggetouMapReady=()=>finish();
    script.src=`https://api.map.baidu.com/api?${new URLSearchParams({v:"1.0",type:"webgl",ak:state.config.browser_ak,callback:"penggetouMapReady"})}`;
    script.onerror=()=>finish(new Error("地图暂时无法加载，可使用下方完整路线链接。"));
    document.head.append(script);
  });
  return state.mapPromise;
}

async function renderMap(candidate) {
  const wrap=$("#map-wrap");
  const version=state.mapVersion, participants=state.result.participants;
  wrap.innerHTML='<div class="empty-state" style="min-height:100%;border:0;border-radius:0"><div class="spinner"></div><p class="loading-text">正在加载百度地图…</p></div>';
  try {
    await loadMap();
    if(!wrap.isConnected || version!==state.mapVersion || state.selected!==candidate.uid) return;
    wrap.innerHTML='<div id="baidu-map" class="baidu-map" aria-label="百度地图与参与者路线"></div>';
    const map=new BMapGL.Map("baidu-map"); state.map=map;
    // 页面保持固定，地图缩放通过显式控件操作，避免滚轮误触。
    map.enableScrollWheelZoom(false);
    const destination=new BMapGL.Point(candidate.lng,candidate.lat), bounds=[destination];
    map.centerAndZoom(destination,12);
    map.addControl(new BMapGL.ScaleControl());
    map.addControl(new BMapGL.ZoomControl());
    const addLabel=(point,name,color,person=null)=>{
      const content=person?`<span class="map-person-label">${avatarImage(person)}<span>${escapeHtml(name)}</span></span>`:escapeHtml(name);
      const label=new BMapGL.Label(content,{position:point,offset:new BMapGL.Size(-12,-30)});
      label.setStyle({backgroundColor:color,color:"white",border:"0",borderRadius:"8px",padding:"5px 9px",fontSize:"13px"});
      map.addOverlay(label);
    };
    addLabel(destination,candidate.name,"#1d1d1f");
    let missingPaths=false;
    participants.forEach((p,i)=>{
      const origin=new BMapGL.Point(p.origin.lng,p.origin.lat); bounds.push(origin);
      addLabel(origin,p.name,colorFor(i),state.people[i]);
      let drawn=false;
      for(const segment of candidate.routes[i].segments) {
        if(segment.points.length<2) continue;
        const points=segment.points.map(([lng,lat])=>new BMapGL.Point(lng,lat));
        map.addOverlay(new BMapGL.Polyline(points,{strokeColor:colorFor(i),strokeWeight:5,strokeOpacity:.85,strokeStyle:segment.walking?"dashed":"solid"}));
        bounds.push(...points); drawn=true;
      }
      if(!drawn) missingPaths=true;
    });
    map.setViewport(bounds,{margins:[65,45,55,45]});
    // 保留百度地图自己的版权和审图信息，缺少路线几何时不画虚构直线。
    if(missingPaths) {
      const note=document.createElement("div"); note.className="map-caption";
      note.innerHTML="<span>部分路线未返回路径，请通过下方链接查看完整路线。</span>";
      wrap.append(note);
    }
  } catch(error) {
    if(wrap.isConnected && version===state.mapVersion) wrap.innerHTML=`<div class="empty-state" style="min-height:100%;border:0;border-radius:0"><span class="empty-symbol">◎</span><p>${escapeHtml(error.message)}</p></div>`;
  }
}

// 底部面板使用原生按钮控制；桌面端始终展示表单。
function setSheetExpanded(expanded) {
  $("#planning-panel").classList.toggle("sheet-collapsed", !expanded);
  $("#sheet-toggle").setAttribute("aria-expanded", String(expanded));
}
$("#sheet-toggle").addEventListener("click",()=>{
  setSheetExpanded($("#sheet-toggle").getAttribute("aria-expanded")!=="true");
});
$("#meeting-form").addEventListener("submit",submitMeeting);
$("#add-person").addEventListener("click",()=>{
  if(state.people.length>=6) return;
  state.people.push(person(nextFriendName())); renderPeople(); showPerson(); invalidate();
});
$("#activity").addEventListener("change",invalidate);
$("#city").addEventListener("input",()=>{
  state.people.forEach((p)=>{p.origin=null;p.query="";p.searchVersion++;});
  $("#location-status").textContent="会合城市已修改，请重新选择所有人的出发地点。";
  renderPeople(); invalidate();
});
document.querySelectorAll("[data-strategy]").forEach((button)=>button.addEventListener("click",()=>{
  if(state.busy || !state.result?.feasible_count) return;
  // 每次切换都选中对应排序的首位，不能沿用上一个策略手动选中的候选。
  state.strategy=button.dataset.strategy; state.selected=null;
  renderResults();
}));
$("#locate-button").addEventListener("click",locateMe);
document.querySelectorAll('[data-view]').forEach((button)=>button.addEventListener('click',()=>setMobileView(button.dataset.view)));
window.addEventListener('resize',syncRoutePage);
$("#avatar-close").addEventListener("click",()=>$("#avatar-dialog").close());

async function initialize() {
  state.people=[person("我")];
  state.people.push(person("朋友"));
  renderPeople(); renderResults(); setBusy(false);
  try {
    state.config=await api("/api/config");
    setBusy(false);
    if(!state.config.live_ready) {
      $("#location-status").textContent="地图服务尚未配置，暂时无法定位。";
      showError("请先配置百度地图服务端密钥并重启服务。");
      return;
    }
    await locateMe();
  } catch(error) {
    showError(error.message);
    $("#location-status").textContent="服务连接失败，暂时无法自动定位。";
    setBusy(false);
  }
}
initialize();
