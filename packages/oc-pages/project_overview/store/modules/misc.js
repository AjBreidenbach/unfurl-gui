import _ from 'lodash'
import { USER_HOME_PROJECT} from 'oc_vue_shared/util.mjs'
const DEFAULT_ROUTER_HOOK = (to, from, next) => next()

function isMobileLayout() {
    // gitlab is using this breakpoint a lot
    return window.innerWidth <= 768
}

const state = {
    routerHook: DEFAULT_ROUTER_HOOK,
    isMobileLayout: isMobileLayout()
}

const mutations = {
    setRouterHook(state, hook) {
        if(hook) { state.routerHook = hook }
        else { state.routerHook = DEFAULT_ROUTER_HOOK }
    },

    setMobileLayout(state, isMobileLayout) {
        state.isMobileLayout = isMobileLayout
    }

}

const getters = {
    getRouterHook(state) {return state.routerHook},
    getHomeProjectPath(_, getters)  {return `${getters.getUsername}/${USER_HOME_PROJECT}`},
    getCurrentNamespace(_, getters) {return getters.getUsername},
    getUsername() {return window.gon.current_username},
    getFullname() {return window.gon.current_user_fullname},
    isMobileLayout() {return state.isMobileLayout},
    pipelinesPath(_, getters) { return `/${getters.getHomeProjectPath}/-/pipelines` },
    UNFURL_MOCK_DEPLOY() {
        if((/(&|\?)(unfurl(-|_))?mock(_|-)deploy/i).test(window.location.search)) return true
        let key = Object.keys(sessionStorage).find(key => (/(unfurl(-|_))?mock(_|-)deploy/i).test(key))
        if(key && sessionStorage[key]) return true
        return false
    },
    REVEAL_HIDDEN_TEMPLATES() {
        return !!Object.keys(sessionStorage).find(key => key == 'reveal-hidden-templates')
    },
    UNFURL_TRACE() {
        return !!Object.keys(sessionStorage).find(key => key == 'unfurl-trace')
    },
    DEPLOY_IMAGE() {
        return sessionStorage['deploy-image'] || 'onecommons/unfurl:latest'
    },
    registryURL() {
        return sessionStorage['registry-url']
    }
    /*
    DEPLOY_TAG() {
        return sessionStorage['deploy-tag'] || 'latest'
    }
    */
}

const actions = {
    handleResize({commit, state}) {
        window.addEventListener('resize', _.debounce(
            function(e) {
                const _isMobileLayout = isMobileLayout()
                if(_isMobileLayout != state.isMobileLayout) {
                    commit('setMobileLayout', _isMobileLayout)
                }
            }, 
            30
        ))
    },
}

export default {state, mutations, getters, actions}
