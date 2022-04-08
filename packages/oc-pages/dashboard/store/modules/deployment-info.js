import DeploymentItem from './deployment-info/deployment-item'
import gql from 'graphql-tag'
import graphqlClient from '../../graphql'

const LOOKUP_JOBS = gql`
    query lookupJobs($fullPath: ID!){
        project(fullPath: $fullPath){
            name
            pipelines {
                count
                nodes {
                    id
                    jobs {
                        count
                        nodes {
                            id
                            status

                        }
                    }
                }
            }
        }
    }
`


const state = {
    deploymentItems: {},
    jobsByPipelineId: {}
}
const getters = {
    deploymentItemDirect(state) {
        return function({environment, deployment}, method, ...args) {
            const key = `${environment?.name}:${deployment?.name}`
            let result = state.deploymentItems[key]
            if(result && method) {
                if(args.length) {
                    result = result[method](...args)
                } else {
                    result = result[method]
                }
            }
            return result
        }
    },
    jobByPipelineId(state) {
        return function(pipelineId) {
            return state.jobsByPipelineId[pipelineId]
        }
    }
}

const mutations = {
    setDeploymentItems(state, deploymentItems) {
        state.deploymentItems = deploymentItems
    },
    setJobsByPipelineId(state, jobsByPipelineId) {
        state.jobsByPipelineId = jobsByPipelineId
    }
}

const actions = {
    populateDeploymentItems({state, getters, rootGetters, commit}, items) {
        const dict = {}
        for(const item of items) {
            let itemKey
            try {
                itemKey = `${item.context.environment.name}:${item.context.deployment.name}`
            } catch(e) {continue}
            if(!dict[itemKey]) {
                const context = {}
                context.environment = item.context.environment
                context.deployment = item.context.deployment
                context.application = item.context.application
                context.deployPath = rootGetters.lookupDeployPath(context.deployment.name, context.environment.name)
                context.job = getters.jobByPipelineId(context.deployPath?.pipeline?.id)
                context.projectPath = rootGetters.getHomeProjectPath
                dict[itemKey] = new DeploymentItem(context)
            }
        }
        commit('setDeploymentItems', dict)
    },
    async populateJobsList({rootGetters, commit}) {
        const result = await graphqlClient.defaultClient.query({
            query: LOOKUP_JOBS,
            variables: {fullPath: rootGetters.getHomeProjectPath}
        })

        const newJobsByPipelineId = {}
        for(const pipeline of result.data.project.pipelines.nodes || []) {
            const pipelineId = pipeline.id.split('/').pop()
            for(const job of pipeline.jobs.nodes) {
                const jobId = job.id.split('/').pop()
                const status = job.status

                newJobsByPipelineId[pipelineId] = Object.freeze({id: jobId, status})
            }
        }
        commit('setJobsByPipelineId', newJobsByPipelineId)
    }
}

export default {
    state, getters, mutations, actions
}
