(function(root) {
    'use strict';
    const VERSION = 'year-context-20261009-v2';
    const yearFormatter=new Intl.DateTimeFormat('en',{timeZone:'Asia/Seoul',year:'numeric'});
    let clockMinute=-1,clockYear=null;
    const currentYear = () => {const minute=Math.floor(Date.now()/60000);if(minute!==clockMinute){clockMinute=minute;clockYear=Number(yearFormatter.format(new Date()));}return clockYear;};
    const asYear = value => {
        if (value instanceof Date) return Number.isFinite(value.getTime()) ? Number(yearFormatter.format(value)) : null;
        if (typeof value === 'number') {
            if (value >= 1900 && value <= 2200 && Number.isInteger(value)) return value;
            const parsed = root.XLSX?.SSF?.parse_date_code?.(value);
            return parsed && parsed.y >= 1900 && parsed.y <= 2200 ? parsed.y : null;
        }
        const m=String(value??'').trim().match(/^(20\d{2})(?:[-./년]|$)/);
        return m ? Number(m[1]) : null;
    };
    const settlementYear = p => {
        const value=p?.manualSettlementDate;
        if(value instanceof Date)return asYear(value);
        if(typeof value==='number')return root.XLSX?.SSF?.parse_date_code?.(value)?.y||null;
        const m=String(value??'').trim().match(/^(20\d{2})[-./](\d{1,2})(?:[-./](\d{1,2}))?$/);
        if(!m||Number(m[2])<1||Number(m[2])>12)return null;
        if(m[3]&&(Number(m[3])<1||Number(m[3])>new Date(Number(m[1]),Number(m[2]),0).getDate()))return null;
        return Number(m[1]);
    };
    const scheduleYears = p => {
        const years=new Set(),a=asYear(p?.startDateStr||p?.startDate),b=asYear(p?.endDateStr||p?.endDate);
        if(a&&b&&b>=a&&b-a<=100) for(let y=a;y<=b;y++) years.add(y);
        else {if(a) years.add(a);if(b) years.add(b);}
        const dates=Array.isArray(p?.workDate)?p.workDate:[p?.workDate];
        for(const d of dates){const y=asYear(d&&typeof d==='object'&&!(d instanceof Date)?d.date:d);if(y) years.add(y);}
        return years;
    };
    function classification(p,now=currentYear()) {
        const year=settlementYear(p),completed=Number(p?.progress)>=100;
        if(year)return {kind:'settled',year,completed};
        const value=String(p?.manualSettlementDate??'').trim();
        if(value&&!/^(작업중|작업 중|미정산|정산 대기|정산대기)$/.test(value))return {kind:'unknown',year:null,completed};
        const years=[...scheduleYears(p)];
        if(years.length&&years.every(y=>y>now))return {kind:'planned',year:Math.min(...years),completed};
        return {kind:'open',year:now,completed};
    }
    const accountingYear=(p,now=currentYear())=>classification(p,now).year;
    const membership = (p,now=currentYear()) => {const s=scheduleYears(p),y=accountingYear(p,now);if(y)s.add(y);return s;};
    const availableYears = projects => [...new Set((projects||[]).flatMap(p=>[...membership(p)]))].sort((a,b)=>b-a);
    const chooseDefault = (years,now=currentYear()) => years.includes(now)?now:(years.filter(y=>y<=now).sort((a,b)=>b-a)[0]||now);
    let selected=null,explicit=false,editUnlocked=false,includeOpen=true,generation=0,metadataYears=[],financialMetadata=null,bootStatus='원본 연결 중',lastSource=null,lastLength=-1,cachedYears=[],yearMemo=new WeakMap();
    const canonical=()=>Array.isArray(root.projectData)?root.projectData:[];
    const canonicalYears=()=>{const source=canonical();if(source!==lastSource||source.length!==lastLength){lastSource=source;lastLength=source.length;cachedYears=availableYears(source);}return cachedYears;};
    function invalidate(){lastSource=null;yearMemo=new WeakMap();}
    function memo(p){let m=yearMemo.get(p);const signature=[p.startDateStr||p.startDate,p.endDateStr||p.endDate,p.manualSettlementDate,p.progress,p.workDate?.length,currentYear()].join('|');if(!m||m.signature!==signature||m.workDates!==p.workDate){m={signature,workDates:p.workDate,years:scheduleYears(p),classification:classification(p)};yearMemo.set(p,m);}return m;}
    function ensure(projects=canonical()) {
        if(selected===null)selected=chooseDefault(metadataYears.length?metadataYears:canonicalYears());
        if(!explicit&&projects.length&&!metadataYears.length)selected=chooseDefault(canonicalYears());
        return selected;
    }
    function scope(projects,basis='union',year=ensure()) {
        const list=Array.isArray(projects)?projects:[];
        if(year==='all'&&basis!=='unassigned'&&basis!=='open')return basis==='financial'?list.filter(p=>memo(p).classification.kind!=='unknown'):list;
        return list.filter(p=>{
            const m=memo(p),c=m.classification;
            if(basis==='unassigned')return c.kind==='unknown';
            if(basis==='open')return c.kind==='open'&&c.year===year;
            const financial=c.year===year&&c.kind!=='unknown'&&(c.kind!=='open'||includeOpen);
            if(basis==='financial')return financial;
            const schedule=m.years.has(year)||(c.kind==='open'&&c.year===year&&includeOpen);
            if(c.kind==='open'&&c.year===year&&!includeOpen)return false;
            return basis==='schedule'?schedule:financial||schedule;
        });
    }
    function financialWithUnassigned(projects) {
        // Future plans have no settled month and must not become a historical/current "working" settlement card.
        return scope(projects,'financial').filter(p=>memo(p).classification.kind!=='planned');
    }
    function scopeWork(project) {
        const year=ensure();if(!project||year==='all'||!Array.isArray(project.workDate))return project;
        const indices=[];project.workDate.forEach((entry,index)=>{if(asYear(entry&&typeof entry==='object'&&!(entry instanceof Date)?entry.date:entry)===year)indices.push(index);});
        if(indices.length===project.workDate.length)return project;
        const copy={...project,workDate:indices.map(i=>project.workDate[i])};
        if(Array.isArray(project.workDetail))copy.workDetail=indices.map(i=>project.workDetail[i]);
        return copy;
    }
    function getViewState(){const year=ensure(),now=currentYear();return {year,currentYear:now,readonly:!!root.YearBootCoordinator?.isCurrentLoading?.()||year==='all'||(year<now&&!editUnlocked),editUnlocked,includeOpen,generation};}
    function getState(){
        const now=currentYear(),source=canonical(),partial=financialMetadata&&root.YearBootCoordinator&&!root.YearBootCoordinator.getState().complete;
        const open=partial?financialMetadata.open:source.reduce((a,p)=>{const c=memo(p).classification;if(c.kind==='open'){a.count++;a.po+=Number(p.poAmount)||0;if(c.completed)a.completed++;}return a;},{count:0,po:0,completed:0});
        return {version:VERSION,year:ensure(),currentYear:now,years:[...new Set([...metadataYears,...canonicalYears()])].sort((a,b)=>b-a),explicit,readonly:!!root.YearBootCoordinator?.isCurrentLoading?.()||selected==='all'||(selected<now&&!editUnlocked),editUnlocked,includeOpen,openCount:open?.count||0,open:open||{count:0,po:0,completed:0},generation,bootStatus};
    }
    function beforeChange() {
        if(root.CodexWorkContentSearch?.canChangeYear?.()===false||root.CodexProjectManager?.canChangeYear?.()===false)throw new Error('편집 중인 작업일·프로젝트를 먼저 적용하거나 취소해 주세요. 입력은 그대로 보존됩니다.');
        const add=root.document?.getElementById('codexAddNewProjectModal');
        if(add&&!add.classList.contains('hidden')&&add.getAttribute('aria-hidden')!=='true')throw new Error('새 프로젝트 입력을 먼저 적용하거나 닫아 주세요. 입력은 그대로 보존됩니다.');
        for(const input of root.document?.querySelectorAll('.settlement-individual-month')||[]){
            if(!input.getClientRects().length)continue;
            const project=canonical().find(p=>String(p.id)===String(input.dataset.projectId));
            if(input.value!==String(project?.manualSettlementDate||''))throw new Error('정산월 입력을 먼저 저장하거나 취소해 주세요. 입력은 그대로 보존됩니다.');
        }
        const event=typeof root.CustomEvent==='function'?new root.CustomEvent('operation-year:beforechange',{cancelable:true}):null;
        if(event&&root.document&&!root.document.dispatchEvent(event))throw new Error('편집 중인 내용을 먼저 적용하거나 취소해 주세요.');
    }
    function notify(){root.document?.dispatchEvent(new CustomEvent('operation-year:changed',{detail:getState()}));updateUI();return getState();}
    function select(year,options={}) {
        const next=year==='all'?'all':Number(year);
        if(next!=='all'&&(!Number.isInteger(next)||next<2000||next>2199))throw new Error('잘못된 운영 연도');
        if(next!==selected)beforeChange();
        selected=next;explicit=options.explicit!==false;editUnlocked=false;generation++;return notify();
    }
    function setOptions(options={}){if(typeof options.includeOpen==='boolean'&&options.includeOpen!==includeOpen){beforeChange();includeOpen=options.includeOpen;generation++;notify();}return getState();}
    function toggleEdit(){editUnlocked=!editUnlocked;updateUI();return getState();}
    function assertEditable(){if(root.YearBootCoordinator?.isCurrentLoading?.())throw new Error('최신 연도 데이터 준비 완료 후 편집해 주세요.');if(getViewState().readonly)throw new Error('이전 연도는 조회 모드입니다. 이전 연도 수정 버튼으로 수정 모드를 선택해 주세요.');}
    const fmt=n=>Number(n||0).toLocaleString('ko-KR');
    function updateUI(){
        const doc=root.document;if(!doc)return;
        const state=getState(),picker=doc.getElementById('operation-year-select');
        if(picker){
            const years=state.years.includes(state.currentYear)?state.years:[state.currentYear,...state.years];
            const values=[...new Set(years)].sort((a,b)=>b-a);
            const signature=values.join(',');
            if(picker.dataset.years!==signature){picker.replaceChildren(...values.map(y=>{const o=doc.createElement('option');o.value=String(y);o.textContent=y+'년'+(y>state.currentYear?' (예정)':y===state.currentYear?' (현재)':' (이전)');return o;}));const all=doc.createElement('option');all.value='all';all.textContent='전체 기간 (비교·조회)';picker.append(all);picker.dataset.years=signature;}
            picker.value=String(state.year);
        }
        const label=doc.getElementById('operation-year-basis');
        if(label)label.textContent=(state.year==='all'?'전체 기간':state.year+'년')+(state.year>state.currentYear?' · PO: 정산 지정·예정 예산 (예정은 정산 카드에서 제외)':' · PO: 최종 정산월·최신 진행 대기')+' / 일정: 해당 연도 작업'+(state.readonly?' · 조회 모드':'');
        const edit=doc.getElementById('operation-year-edit');if(edit){edit.hidden=!(state.year<state.currentYear);edit.textContent=state.editUnlocked?'이전 연도 수정 종료':'이전 연도 수정';edit.setAttribute('aria-pressed',String(state.editUnlocked));}
        const pending=scope(canonical(),'unassigned'),unassigned=doc.getElementById('operation-year-unassigned');
        const partial=financialMetadata&&root.YearBootCoordinator&&!root.YearBootCoordinator.getState().complete;
        const count=partial?(financialMetadata.unknown?.count||0):pending.length,amount=partial?(financialMetadata.unknown?.po||0):pending.reduce((n,p)=>n+(Number(p.poAmount)||0),0);
        if(unassigned)unassigned.textContent=count?'정산월 확인 필요 (원본 보존): '+fmt(count)+'건 / '+fmt(amount)+'원':'정산월 오류·연도 미확정 0건';
        const progress=doc.getElementById('operation-year-progress');if(progress)progress.textContent=bootStatus;
        const retry=doc.getElementById('operation-year-retry');if(retry)retry.hidden=root.YearBootCoordinator?.getState().phase!=='blocked';
        for(const id of ['overview-header-summaries','settlement-header-summaries']){const el=doc.getElementById(id);if(el){el.dataset.operationYear=String(state.year);el.dataset.amountBasis='final-settlement-current-open';}}
        root.YearBubbleUI?.update(state);
    }
    function mount(){root.YearBubbleUI?.mount();updateUI();}
    function setMetadata(years,financial){metadataYears=(years||[]).map(Number).filter(y=>Number.isInteger(y)&&y>=2000&&y<=2199);financialMetadata=financial||null;if(!explicit)selected=chooseDefault(metadataYears);updateUI();}
    function setBootStatus(text){bootStatus=String(text);updateUI();}
    function clearPreview(){for(const id of ['overview-header-summaries','settlement-header-summaries']){const el=root.document?.getElementById(id);if(el?.hasAttribute('data-fast-header-preview')){el.replaceChildren();el.removeAttribute('data-fast-header-preview');}}}
    const api={VERSION,currentYear,asYear,settlementYear,classification,accountingYear,scheduleYears,membership,availableYears,chooseDefault,scope,scopeWork,financialWithUnassigned,ensure,select,setOptions,toggleEdit,getState,getViewState,assertEditable,updateUI,setMetadata,setBootStatus,clearPreview,mount};
    root.YearContext=api;
    if(typeof module==='object'&&module.exports)module.exports=api;
    if(root.document){
        root.document.addEventListener('DOMContentLoaded',()=>{const saved=root.embeddedSettings?.operationYear;if(saved==='all'||(Number.isInteger(saved)&&saved>=2000&&saved<=2199)){selected=saved;explicit=true;}if(typeof root.embeddedSettings?.yearOptions?.includeOpen==='boolean')includeOpen=root.embeddedSettings.yearOptions.includeOpen;mount();clearPreview();}, {once:true});
        root.document.addEventListener('data:loaded',()=>{invalidate();ensure();updateUI();});
        root.document.addEventListener('data:changed',()=>{invalidate();ensure();updateUI();});
        root.document.addEventListener('workdate-data-updated',event=>{if(event.detail?.source==='auto-upload-work-sheet')return;invalidate();ensure();updateUI();});
        // Existing mutation dialogs retain their read/export controls in history mode.
        root.document.addEventListener('click',e=>{
            if(!getViewState().readonly)return;
            const button=e.target.closest?.('button');if(!button||button.closest('#operation-year-modal')||button.id==='applyMappingBtn')return;
            const dialog=button.closest('[role="dialog"],.modal,[id$="Modal"],[id$="modal"]');
            if(!dialog)return;
            const title=String(button.textContent||'').trim();
            if(/^(추가|수정|삭제|저장|적용|일괄 삭제|작업일 삭제|작업일 추가|확인 후 저장)(?:\s|$)/.test(title)&&!/(필터|검색|날짜|정렬|Excel|엑셀|다운)/.test(title)){
                e.preventDefault();e.stopImmediatePropagation();root.showToast?.(root.YearBootCoordinator?.isCurrentLoading?.()?'최신 연도 데이터 준비 완료 후 편집해 주세요.':'이전 연도 수정 모드를 먼저 선택해 주세요.','warning');
            }
        },true);
    }
})(typeof window==='object'?window:globalThis);
